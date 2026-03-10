import type * as Effect from "effect/Effect";

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: string | null;
  readonly requiresOpenaiAuth: boolean;
}

export interface CodexDeviceAuthSnapshot {
  readonly loginId: string;
  readonly sandboxId: string;
  readonly worktreePath: string;
  readonly codexHomePath: string;
  readonly ptySessionId: string;
  readonly verificationUri: string | null;
  readonly userCode: string | null;
  readonly status: "pending" | "completed" | "failed" | "cancelled";
  readonly error: string | null;
}

export interface CodexLiveEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly source: "notification" | "request" | "local";
  readonly method: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly requestId: string | null;
  readonly summary: string | null;
  readonly payload: unknown;
}

export interface CodexSessionSnapshot {
  readonly sessionId: string;
  readonly sandboxId: string;
  readonly worktreePath: string;
  readonly codexHomePath: string;
  readonly ptySessionId: string;
  readonly status: "starting" | "ready" | "stopped" | "error";
  readonly account: CodexAccountSnapshot;
  readonly activeThreadId: string | null;
  readonly activeTurnId: string | null;
  readonly pendingApprovalRequests: readonly CodexPendingApprovalRequest[];
  readonly pendingUserInputRequests: readonly CodexPendingUserInputRequest[];
  readonly recentEvents: readonly CodexLiveEvent[];
  readonly protocolErrors: readonly string[];
}

export interface CodexStoredTurn {
  readonly id: string;
  readonly items: readonly unknown[];
  readonly status: string;
  readonly error: unknown;
}

export interface CodexStoredThread {
  readonly id: string;
  readonly preview: string;
  readonly ephemeral: boolean;
  readonly modelProvider: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: unknown;
  readonly path: string | null;
  readonly cwd: string;
  readonly cliVersion: string;
  readonly source: unknown;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly gitInfo: unknown;
  readonly name: string | null;
  readonly turns: readonly CodexStoredTurn[];
}

export interface CodexCompletedTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: string;
  readonly error: unknown;
}

export interface CodexSessionSubscriptionEvent {
  readonly session: CodexSessionSnapshot;
  readonly liveEvent: CodexLiveEvent | null;
}

export type CodexSessionListener = (event: CodexSessionSubscriptionEvent) => void | Promise<void>;

export interface StartCodexSessionOptions {
  readonly sandboxId: string;
  readonly worktreePath: string;
  readonly codexHomePath?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface StartDeviceAuthOptions {
  readonly sandboxId: string;
  readonly worktreePath: string;
  readonly codexHomePath?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface OpenCodexThreadOptions {
  readonly sessionId: string;
  readonly threadId?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly serviceTier?: "default" | "flex" | "priority" | "auto" | null;
  readonly ephemeral?: boolean;
  readonly persistExtendedHistory?: boolean;
  readonly experimentalRawEvents?: boolean;
}

export interface SendCodexTurnOptions {
  readonly sessionId: string;
  readonly threadId?: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: "default" | "flex" | "priority" | "auto" | null;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "minimal" | null;
  readonly summary?: "auto" | "detailed" | null;
  readonly onAgentMessageDelta?: (delta: string) => void | Promise<void>;
}

export interface ListStoredThreadsOptions {
  readonly sessionId: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly archived?: boolean;
  readonly cwd?: string;
  readonly sourceKinds?: readonly string[];
}

export interface ReadStoredThreadOptions {
  readonly sessionId: string;
  readonly threadId: string;
}

export interface CodexPendingApprovalRequest {
  readonly requestId: string;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexPendingUserInputRequest {
  readonly requestId: string;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexServiceShape {
  readonly startSession: (
    options: StartCodexSessionOptions,
  ) => Effect.Effect<CodexSessionSnapshot, import("./app-server.errors").StartCodexSessionError>;
  readonly stopSession: (
    sessionId: string,
  ) => Effect.Effect<
    void,
    | import("./app-server.errors").CodexSessionNotFoundError
    | import("../terminal").TerminalCleanupError
  >;
  readonly getSession: (
    sessionId: string,
  ) => Effect.Effect<CodexSessionSnapshot, import("./app-server.errors").CodexSessionNotFoundError>;
  readonly subscribeSession: (
    sessionId: string,
    listener: CodexSessionListener,
  ) => Effect.Effect<() => void, import("./app-server.errors").CodexSessionNotFoundError>;
  readonly listSessions: () => Effect.Effect<readonly CodexSessionSnapshot[]>;
  readonly startDeviceAuth: (
    options: StartDeviceAuthOptions,
  ) => Effect.Effect<CodexDeviceAuthSnapshot, import("./app-server.errors").StartDeviceAuthError>;
  readonly getDeviceAuth: (
    loginId: string,
  ) => Effect.Effect<
    CodexDeviceAuthSnapshot,
    import("./app-server.errors").CodexDeviceAuthNotFoundError
  >;
  readonly awaitDeviceAuth: (
    loginId: string,
    timeoutMs?: number,
  ) => Effect.Effect<
    CodexDeviceAuthSnapshot,
    | import("./app-server.errors").CodexDeviceAuthNotFoundError
    | import("./app-server.errors").CodexWaitForLoginError
  >;
  readonly cancelDeviceAuth: (
    loginId: string,
  ) => Effect.Effect<
    void,
    | import("./app-server.errors").CodexDeviceAuthNotFoundError
    | import("../terminal").TerminalCleanupError
  >;
  readonly readAccount: (
    sessionId: string,
  ) => Effect.Effect<CodexAccountSnapshot, import("./app-server.errors").ReadCodexSessionError>;
  readonly loginWithApiKey: (
    sessionId: string,
    apiKey: string,
  ) => Effect.Effect<CodexAccountSnapshot, import("./app-server.errors").ReadCodexSessionError>;
  readonly openThread: (
    options: OpenCodexThreadOptions,
  ) => Effect.Effect<CodexStoredThread, import("./app-server.errors").OpenCodexThreadError>;
  readonly sendTurn: (
    options: SendCodexTurnOptions,
  ) => Effect.Effect<
    { readonly threadId: string; readonly turnId: string },
    import("./app-server.errors").SendCodexTurnError
  >;
  readonly awaitTurn: (
    sessionId: string,
    turnId: string,
    timeoutMs?: number,
  ) => Effect.Effect<CodexCompletedTurn, import("./app-server.errors").WaitForCodexTurnError>;
  readonly interruptTurn: (
    sessionId: string,
    turnId?: string,
  ) => Effect.Effect<void, import("./app-server.errors").ReadCodexSessionError>;
  readonly respondToApproval: (
    sessionId: string,
    requestId: string,
    decision: CodexApprovalDecision,
  ) => Effect.Effect<void, import("./app-server.errors").ReadCodexSessionError>;
  readonly respondToUserInput: (
    sessionId: string,
    requestId: string,
    answers: Record<string, readonly string[]>,
  ) => Effect.Effect<void, import("./app-server.errors").ReadCodexSessionError>;
  readonly listStoredThreads: (
    options: ListStoredThreadsOptions,
  ) => Effect.Effect<
    { readonly data: readonly CodexStoredThread[]; readonly nextCursor: string | null },
    import("./app-server.errors").ReadCodexSessionError
  >;
  readonly readStoredThread: (
    options: ReadStoredThreadOptions,
  ) => Effect.Effect<CodexStoredThread, import("./app-server.errors").ReadCodexSessionError>;
  readonly rollbackThread: (
    sessionId: string,
    numTurns: number,
  ) => Effect.Effect<CodexStoredThread, import("./app-server.errors").ReadCodexSessionError>;
}
