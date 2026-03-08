declare module "@github/copilot-sdk" {
  export type CopilotClientOptions = any;
  export type ModelInfo = any;
  export type PermissionRequest = any;
  export type PermissionRequestResult = any;
  export type SessionEvent = any;
  export type CopilotSession = any;

  export class CopilotClient {
    constructor(options: CopilotClientOptions);
    start(): Promise<void>;
    listModels(): Promise<ModelInfo[]>;
    createSession(config: any): Promise<CopilotSession>;
    resumeSession(sessionId: string, config: any): Promise<CopilotSession>;
    stop(): Promise<Error[]>;
  }
}
