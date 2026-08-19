import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { buildCodexChildEnvironment } from "../child-environment.js";
import { resolvePinnedCodexExecutable } from "./executable.js";
import {
  type AppServerNotification,
  type AppServerRequest,
  type AppServerRequestResolution,
  CodexAppServerConnectionClosedError,
  CodexAppServerProtocolError,
  CodexAppServerRequestTimeoutError,
  MAXIMUM_PROTOCOL_LINE_BYTES,
  notificationEnvelopeSchema,
  responseEnvelopeSchema,
  serverRequestEnvelopeSchema,
} from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CodexAppServerConnection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void;
  onClosed(listener: () => void): () => void;
  onServerRequest?(
    listener: (
      request: AppServerRequest,
    ) => Promise<AppServerRequestResolution> | AppServerRequestResolution,
  ): () => void;
  close(): Promise<void>;
}

export type CodexAppServerConnectionFactory =
  () => Promise<CodexAppServerConnection>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  written: boolean;
}

export class StdioCodexAppServerConnection
  implements CodexAppServerConnection
{
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<
    (notification: AppServerNotification) => void
  >();
  readonly #closedListeners = new Set<() => void>();
  #serverRequestListener:
    | ((
        request: AppServerRequest,
      ) => Promise<AppServerRequestResolution> | AppServerRequestResolution)
    | undefined;
  #requestId = 0;
  #closed = false;
  #terminating = false;
  #forceKillTimer: NodeJS.Timeout | undefined;
  #lineChunks: Buffer[] = [];
  #lineBytes = 0;

  private constructor(
    process: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
  ) {
    this.#process = process;
    this.#requestTimeoutMs = requestTimeoutMs;
    process.stdout.on("data", (chunk: Buffer) => this.#handleStdoutChunk(chunk));
    process.stdout.once("end", () => this.#beginTermination());
    process.stdout.once("error", () => this.#beginTermination());
    process.stdin.on("error", () => this.#beginTermination());
    process.stdin.once("close", () => this.#beginTermination());
    process.once("error", () => this.#beginTermination());
    process.once("exit", () => this.#handleClosed());
  }

  public static async connect(options: {
    codexHome: string;
    parentEnvironment: Readonly<NodeJS.ProcessEnv>;
    executablePath?: string;
    requestTimeoutMs?: number;
  }): Promise<StdioCodexAppServerConnection> {
    if (!isAbsolute(options.codexHome)) {
      throw new Error("CODEX_HOME must be absolute before App Server starts.");
    }
    const codexHome = resolve(options.codexHome);
    const environment = buildCodexChildEnvironment({
      parentEnvironment: options.parentEnvironment,
      codexHome,
      authMode: "chatgpt",
    });
    const child = spawn(
      options.executablePath ?? resolvePinnedCodexExecutable(),
      ["app-server", "--stdio"],
      {
        cwd: codexHome,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    // Never forward or persist App Server stderr. Provider details and paths
    // are not part of the dashboard or setup API contract.
    child.stderr.resume();
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    return new StdioCodexAppServerConnection(
      child,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      throw new CodexAppServerProtocolError();
    }
    const id = ++this.#requestId;
    const response = new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        rejectRequest(
          new CodexAppServerRequestTimeoutError(pending?.written ?? false),
        );
      }, this.#requestTimeoutMs);
      timeout.unref();
      this.#pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
        written: false,
      });
    });
    try {
      this.#write({ method, id, params });
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        pending.written = true;
      }
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(
          error instanceof Error ? error : new CodexAppServerProtocolError(),
        );
      }
    }
    return await response;
  }

  public notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  public onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public onClosed(listener: () => void): () => void {
    if (this.#closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  public onServerRequest(
    listener: (
      request: AppServerRequest,
    ) => Promise<AppServerRequestResolution> | AppServerRequestResolution,
  ): () => void {
    if (this.#serverRequestListener !== undefined) {
      throw new Error("Codex App Server already has a server-request router.");
    }
    this.#serverRequestListener = listener;
    return () => {
      if (this.#serverRequestListener === listener) {
        this.#serverRequestListener = undefined;
      }
    };
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const exited =
      this.#process.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolveExit) => {
            this.#process.once("exit", () => resolveExit());
          });
    this.#beginTermination();
    await exited;
    this.#handleClosed();
  }

  #write(message: unknown): void {
    if (
      this.#closed ||
      this.#terminating ||
      !this.#process.stdin.writable
    ) {
      throw new CodexAppServerConnectionClosedError(false);
    }
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleStdoutChunk(chunk: Buffer): void {
    if (this.#closed || this.#terminating) {
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segmentBytes = end - offset;
      if (this.#lineBytes + segmentBytes > MAXIMUM_PROTOCOL_LINE_BYTES) {
        this.#beginTermination();
        return;
      }
      if (segmentBytes > 0) {
        this.#lineChunks.push(Buffer.from(chunk.subarray(offset, end)));
        this.#lineBytes += segmentBytes;
      }
      if (newline === -1) {
        return;
      }
      const line = Buffer.concat(this.#lineChunks, this.#lineBytes).toString(
        "utf8",
      );
      this.#lineChunks = [];
      this.#lineBytes = 0;
      this.#handleLine(line);
      if (this.#terminating || this.#closed) {
        return;
      }
      offset = newline + 1;
    }
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#beginTermination();
      return;
    }

    const response = responseEnvelopeSchema.safeParse(value);
    if (response.success) {
      const pending = this.#pending.get(response.data.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(response.data.id);
      clearTimeout(pending.timeout);
      if (response.data.error !== undefined) {
        pending.reject(new CodexAppServerProtocolError());
      } else {
        pending.resolve(response.data.result);
      }
      return;
    }

    const notification = notificationEnvelopeSchema.safeParse(value);
    if (notification.success && !("id" in notification.data)) {
      for (const listener of this.#notificationListeners) {
        try {
          listener(notification.data);
        } catch {
          // One consumer cannot break the shared protocol read loop.
        }
      }
      return;
    }

    const serverRequest = serverRequestEnvelopeSchema.safeParse(value);
    if (serverRequest.success) {
      void this.#handleServerRequest(serverRequest.data);
    }
  }

  async #handleServerRequest(request: AppServerRequest): Promise<void> {
    const listener = this.#serverRequestListener;
    let resolution: AppServerRequestResolution;
    if (listener === undefined) {
      resolution = {
        error: {
          code: -32_601,
          message: "Server request has no configured router.",
        },
      };
    } else {
      try {
        resolution = await listener(request);
      } catch {
        resolution = {
          error: {
            code: -32_603,
            message: "Server request was rejected by the client.",
          },
        };
      }
    }
    try {
      this.#write({ id: request.id, ...resolution });
    } catch {
      // The connection already closed; no other process may receive this reply.
    }
  }

  #handleClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#terminating = true;
    if (this.#forceKillTimer !== undefined) {
      clearTimeout(this.#forceKillTimer);
      this.#forceKillTimer = undefined;
    }
    this.#lineChunks = [];
    this.#lineBytes = 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new CodexAppServerConnectionClosedError(pending.written),
      );
    }
    this.#pending.clear();
    for (const listener of this.#closedListeners) {
      try {
        listener();
      } catch {
        // Continue notifying every connection consumer.
      }
    }
  }

  #beginTermination(): void {
    if (this.#closed || this.#terminating) {
      return;
    }
    this.#terminating = true;
    if (this.#process.exitCode !== null) {
      this.#handleClosed();
      return;
    }
    this.#process.kill("SIGTERM");
    this.#forceKillTimer = setTimeout(() => {
      if (this.#process.exitCode === null) {
        this.#process.kill("SIGKILL");
      }
    }, 2_000);
    this.#forceKillTimer.unref();
  }
}
