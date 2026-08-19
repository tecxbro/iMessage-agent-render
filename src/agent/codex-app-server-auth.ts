import type {
  CapabilitiesListener,
  CodexAccountCapabilitiesSnapshot,
} from "./codex-account-capabilities.js";
import type { CodexAppServerConnectionFactory } from "./codex-app-server/transport.js";
import { CodexAppServerSupervisor } from "./codex-app-server/supervisor.js";
import type {
  ChatGptSetupStatus,
  ConnectedListener,
} from "./chatgpt-auth-state-machine.js";

export { CHATGPT_SETUP_ERROR_CODES } from "./chatgpt-auth-state-machine.js";
export type {
  ChatGptSetupController,
  ChatGptSetupErrorCode,
  ChatGptSetupStatus,
} from "./chatgpt-auth-state-machine.js";
export type {
  CodexAppServerConnection,
  CodexAppServerConnectionFactory,
} from "./codex-app-server/transport.js";

export interface CodexAppServerAuthOptions {
  codexHome: string;
  parentEnvironment: Readonly<NodeJS.ProcessEnv>;
  /** Test seam for a compatible executable; production uses the pinned package. */
  executablePath?: string;
  requestTimeoutMs?: number;
  connectionFactory?: CodexAppServerConnectionFactory;
  supervisor?: CodexAppServerSupervisor;
}

export class CodexAppServerAuth {
  public readonly supervisor: CodexAppServerSupervisor;

  public constructor(options: CodexAppServerAuthOptions) {
    this.supervisor =
      options.supervisor ??
      new CodexAppServerSupervisor({
        codexHome: options.codexHome,
        parentEnvironment: options.parentEnvironment,
        ...(options.executablePath === undefined
          ? {}
          : { executablePath: options.executablePath }),
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.connectionFactory === undefined
          ? {}
          : { connectionFactory: options.connectionFactory }),
      });
  }

  public initialize(): Promise<ChatGptSetupStatus> {
    return this.supervisor.authenticationController.initialize();
  }

  public start(): Promise<ChatGptSetupStatus> {
    return this.supervisor.authenticationController.start();
  }

  public status(): ChatGptSetupStatus {
    return this.supervisor.authenticationController.status();
  }

  public capabilities(): CodexAccountCapabilitiesSnapshot {
    return this.supervisor.authenticationController.capabilities();
  }

  public refreshCapabilities(): Promise<CodexAccountCapabilitiesSnapshot> {
    return this.supervisor.authenticationController.refreshCapabilities();
  }

  public onCapabilitiesChanged(listener: CapabilitiesListener): () => void {
    return this.supervisor.authenticationController.onCapabilitiesChanged(
      listener,
    );
  }

  public onConnected(listener: ConnectedListener): () => void {
    return this.supervisor.authenticationController.onConnected(listener);
  }

  public async close(): Promise<void> {
    await this.supervisor.close();
  }
}
