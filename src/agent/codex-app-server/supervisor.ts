import { ChatGptAuthStateMachine } from "../chatgpt-auth-state-machine.js";
import { ChatGptModelCapabilitySource } from "../model-capability-source.js";
import { CodexAppServerEventRouter } from "./event-router.js";
import { CodexAppServerInteractionClient } from "./interaction-client.js";
import {
  type AppServerNotification,
  type AppServerRequest,
  type AppServerRequestResolution,
  CodexAppServerGenerationChangedError,
  CodexAppServerProtocolError,
} from "./protocol.js";
import {
  type CodexAppServerRequestHandlers,
  CodexAppServerRequestRouter,
} from "./request-router.js";
import {
  type CodexAppServerConnection,
  type CodexAppServerConnectionFactory,
  StdioCodexAppServerConnection,
} from "./transport.js";

const AUTOMATIC_RECONNECT_DELAYS_MS = [25, 100, 500] as const;
const RECONNECT_STABILITY_WINDOW_MS = 5_000;

export interface CodexAppServerSupervisorOptions {
  codexHome: string;
  parentEnvironment: Readonly<NodeJS.ProcessEnv>;
  executablePath?: string;
  requestTimeoutMs?: number;
  connectionFactory?: CodexAppServerConnectionFactory;
  requestHandlers?: CodexAppServerRequestHandlers;
}

export class CodexAppServerSupervisor {
  public readonly eventRouter = new CodexAppServerEventRouter();
  public readonly requestRouter: CodexAppServerRequestRouter;
  public readonly interactionClient: CodexAppServerInteractionClient;
  public readonly authenticationController: ChatGptAuthStateMachine;
  public readonly capabilitySource: ChatGptModelCapabilitySource;

  readonly #connectionFactory: CodexAppServerConnectionFactory;
  #connection: CodexAppServerConnection | undefined;
  #lease: SupervisorConnectionLease | undefined;
  #connecting: Promise<SupervisorConnectionLease> | undefined;
  #ready: Promise<void> | undefined;
  #generation = 0;
  #initializedGeneration = 0;
  #closing = false;
  #consecutiveAutomaticReconnects = 0;
  #stabilityTimer: NodeJS.Timeout | undefined;

  public constructor(options: CodexAppServerSupervisorOptions) {
    this.requestRouter = new CodexAppServerRequestRouter(
      options.requestHandlers,
    );
    this.#connectionFactory =
      options.connectionFactory ??
      (() =>
        StdioCodexAppServerConnection.connect({
          codexHome: options.codexHome,
          parentEnvironment: options.parentEnvironment,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
        }));
    this.authenticationController = new ChatGptAuthStateMachine({
      codexHome: options.codexHome,
      connectionFactory: async () => await this.#ensureLease(),
    });
    this.capabilitySource = new ChatGptModelCapabilitySource(
      this.authenticationController,
    );
    this.interactionClient = new CodexAppServerInteractionClient(
      {
        request: async (method, params, options) =>
          await this.request(method, params, options),
        generation: () => this.generation(),
      },
      this.eventRouter,
    );
  }

  public generation(): number {
    return this.#generation;
  }

  public processIsInitialized(): boolean {
    return (
      this.#generation > 0 &&
      this.#initializedGeneration === this.#generation &&
      this.#connection !== undefined
    );
  }

  public async initialize(): Promise<void> {
    await this.#ensureReady();
  }

  public async request(
    method: string,
    params: unknown,
    options: { expectedGeneration?: number } = {},
  ): Promise<unknown> {
    await this.#ensureReady();
    const lease = this.#lease;
    if (lease === undefined || lease.generation !== this.#generation) {
      throw new CodexAppServerProtocolError();
    }
    if (
      options.expectedGeneration !== undefined &&
      options.expectedGeneration !== lease.generation
    ) {
      throw new CodexAppServerGenerationChangedError(
        options.expectedGeneration,
        lease.generation,
      );
    }
    // Requests are intentionally never retried. In particular, a written
    // steer must surface its uncertain-submission state to the actor.
    return await lease.request(method, params);
  }

  public async close(): Promise<void> {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    if (this.#stabilityTimer !== undefined) {
      clearTimeout(this.#stabilityTimer);
      this.#stabilityTimer = undefined;
    }
    await this.authenticationController.close();
    const connection = this.#connection;
    this.#connection = undefined;
    this.#lease = undefined;
    this.#initializedGeneration = 0;
    await connection?.close().catch(() => undefined);
    const connecting = this.#connecting;
    if (connecting !== undefined) {
      await connecting
        .then(async (lease) => await lease.close())
        .catch(() => undefined);
    }
    this.#connecting = undefined;
    this.#ready = undefined;
  }

  async #ensureReady(): Promise<void> {
    if (this.#closing) {
      throw new CodexAppServerProtocolError();
    }
    if (this.processIsInitialized()) {
      return;
    }
    if (this.#ready !== undefined) {
      return await this.#ready;
    }
    this.#ready = (async () => {
      await this.authenticationController.initialize();
      if (!this.processIsInitialized()) {
        throw new CodexAppServerProtocolError();
      }
    })();
    try {
      await this.#ready;
    } finally {
      this.#ready = undefined;
    }
  }

  async #ensureLease(): Promise<SupervisorConnectionLease> {
    if (this.#closing) {
      throw new CodexAppServerProtocolError();
    }
    if (this.#lease !== undefined) {
      return this.#lease;
    }
    if (this.#connecting !== undefined) {
      return await this.#connecting;
    }
    this.#connecting = this.#connect();
    try {
      return await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect(): Promise<SupervisorConnectionLease> {
    const connection = await this.#connectionFactory();
    if (this.#closing) {
      await connection.close().catch(() => undefined);
      throw new CodexAppServerProtocolError();
    }
    const generation = this.#generation + 1;
    const lease = new SupervisorConnectionLease(
      connection,
      generation,
      () => {
        if (this.#lease === lease) {
          this.#markInitialized(generation);
        }
      },
    );
    this.#connection = connection;
    this.#lease = lease;
    this.#generation = generation;
    this.eventRouter.setCurrentGeneration(generation);

    connection.onNotification((notification) => {
      lease.emitNotification(notification);
      this.eventRouter.route(notification, generation);
    });
    connection.onClosed(() => {
      this.#processClosed(connection, lease, generation);
    });
    connection.onServerRequest?.(
      async (request) => await this.requestRouter.route(request),
    );
    return lease;
  }

  #processClosed(
    connection: CodexAppServerConnection,
    lease: SupervisorConnectionLease,
    generation: number,
  ): void {
    if (this.#connection !== connection || this.#lease !== lease) {
      return;
    }
    if (this.#stabilityTimer !== undefined) {
      clearTimeout(this.#stabilityTimer);
      this.#stabilityTimer = undefined;
    }
    this.#connection = undefined;
    this.#lease = undefined;
    this.#initializedGeneration = 0;
    this.eventRouter.processClosed(generation);
    lease.emitClosed();
    const reconnectDelay =
      AUTOMATIC_RECONNECT_DELAYS_MS[this.#consecutiveAutomaticReconnects];
    if (!this.#closing && reconnectDelay !== undefined) {
      this.#consecutiveAutomaticReconnects += 1;
      // Authentication also observes the closure. Both paths converge on the
      // same single-flight connection promise, so only one replacement starts.
      // If initialization itself was interrupted, wait for that ready attempt
      // to settle before starting the replacement generation.
      const interruptedReady = this.#ready;
      void (async () => {
        await interruptedReady?.catch(() => undefined);
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, reconnectDelay);
        });
        if (
          !this.#closing &&
          this.#connection === undefined &&
          this.#generation === generation
        ) {
          await this.#ensureReady().catch(() => undefined);
        }
      })();
    }
  }

  #markInitialized(generation: number): void {
    this.#initializedGeneration = generation;
    if (this.#stabilityTimer !== undefined) {
      clearTimeout(this.#stabilityTimer);
    }
    this.#stabilityTimer = setTimeout(() => {
      if (
        !this.#closing &&
        this.#generation === generation &&
        this.#initializedGeneration === generation &&
        this.#connection !== undefined
      ) {
        this.#consecutiveAutomaticReconnects = 0;
      }
      this.#stabilityTimer = undefined;
    }, RECONNECT_STABILITY_WINDOW_MS);
    this.#stabilityTimer.unref();
  }
}

class SupervisorConnectionLease implements CodexAppServerConnection {
  readonly #notificationListeners = new Set<
    (notification: AppServerNotification) => void
  >();
  readonly #closedListeners = new Set<() => void>();
  #closed = false;

  public constructor(
    private readonly connection: CodexAppServerConnection,
    public readonly generation: number,
    private readonly initialized: () => void,
  ) {}

  public async request(method: string, params: unknown): Promise<unknown> {
    return await this.connection.request(method, params);
  }

  public notify(method: string, params: unknown): void {
    this.connection.notify(method, params);
    if (method === "initialized") {
      this.initialized();
    }
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
    _listener: (
      request: AppServerRequest,
    ) => Promise<AppServerRequestResolution> | AppServerRequestResolution,
  ): () => void {
    // The supervisor installs the only server-request router on the raw
    // connection. Leases cannot replace it.
    return () => undefined;
  }

  public async close(): Promise<void> {
    await this.connection.close();
  }

  public emitNotification(notification: AppServerNotification): void {
    if (this.#closed) {
      return;
    }
    for (const listener of this.#notificationListeners) {
      try {
        listener(notification);
      } catch {
        // Authentication listeners cannot break the shared transport loop.
      }
    }
  }

  public emitClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const listener of this.#closedListeners) {
      try {
        listener();
      } catch {
        // Continue notifying every lease listener during process teardown.
      }
    }
  }
}
