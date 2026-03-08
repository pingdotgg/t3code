import type {
  CheckpointRef,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesResult,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusResult,
  ProjectSearchEntriesResult,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  RemoteHostId,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
  ThreadId,
} from "@t3tools/contracts";

export const REMOTE_HELPER_NOTIFICATION_METHODS = {
  providerEvent: "provider.event",
  terminalEvent: "terminal.event",
} as const;

export const REMOTE_HELPER_METHODS = {
  hostPing: "host.ping",
  hostGetCapabilities: "host.getCapabilities",
  providerStartSession: "provider.startSession",
  providerSendTurn: "provider.sendTurn",
  providerInterruptTurn: "provider.interruptTurn",
  providerRespondToRequest: "provider.respondToRequest",
  providerRespondToUserInput: "provider.respondToUserInput",
  providerReadThread: "provider.readThread",
  providerRollbackThread: "provider.rollbackThread",
  providerStopSession: "provider.stopSession",
  providerListSessions: "provider.listSessions",
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",
  workspaceSearchEntries: "workspace.searchEntries",
  workspaceBrowseEntries: "workspace.browseEntries",
  workspaceWriteFile: "workspace.writeFile",
  gitStatus: "git.status",
  gitPull: "git.pull",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  checkpointIsGitRepository: "checkpoint.isGitRepository",
  checkpointCapture: "checkpoint.capture",
  checkpointHasRef: "checkpoint.hasRef",
  checkpointRestore: "checkpoint.restore",
  checkpointDiff: "checkpoint.diff",
  checkpointDeleteRefs: "checkpoint.deleteRefs",
} as const;

export interface RemoteHelperRequest<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params?: TParams;
}

export interface RemoteHelperSuccess<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: TResult;
}

export interface RemoteHelperFailure {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
}

export interface RemoteHelperNotification<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
}

export interface RemoteHelperHostPingResult {
  readonly protocolVersion: number;
  readonly helperVersion: string;
}

export interface RemoteHelperHostCapabilities {
  readonly protocolVersion: number;
  readonly helperVersion: string;
  readonly capabilities: ReadonlyArray<string>;
}

export interface RemoteHelperBrowseEntriesInput {
  readonly cwd: string;
  readonly limit: number;
}

export interface RemoteHelperBrowseEntriesResult {
  readonly cwd: string;
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly parentPath?: string | undefined;
  }>;
  readonly truncated: boolean;
}

export interface RemoteHelperWriteFileInput {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly contents: string;
}

export interface RemoteHelperCheckpointCaptureInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RemoteHelperCheckpointHasRefInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RemoteHelperCheckpointRestoreInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface RemoteHelperCheckpointDiffInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
}

export interface RemoteHelperCheckpointDeleteRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface RemoteHelperProviderReadThreadResult {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{
    readonly id: string;
    readonly items: ReadonlyArray<unknown>;
  }>;
}

export interface RemoteHelperProviderRollbackInput {
  readonly threadId: ThreadId;
  readonly numTurns: number;
}

export interface RemoteHelperNotificationPayloads {
  readonly [REMOTE_HELPER_NOTIFICATION_METHODS.providerEvent]: ProviderRuntimeEvent;
  readonly [REMOTE_HELPER_NOTIFICATION_METHODS.terminalEvent]: TerminalEvent;
}

export interface RemoteHelperMethodResults {
  readonly [REMOTE_HELPER_METHODS.hostPing]: RemoteHelperHostPingResult;
  readonly [REMOTE_HELPER_METHODS.hostGetCapabilities]: RemoteHelperHostCapabilities;
  readonly [REMOTE_HELPER_METHODS.providerStartSession]: ProviderSession;
  readonly [REMOTE_HELPER_METHODS.providerSendTurn]: ProviderTurnStartResult;
  readonly [REMOTE_HELPER_METHODS.providerInterruptTurn]: void;
  readonly [REMOTE_HELPER_METHODS.providerRespondToRequest]: void;
  readonly [REMOTE_HELPER_METHODS.providerRespondToUserInput]: void;
  readonly [REMOTE_HELPER_METHODS.providerReadThread]: RemoteHelperProviderReadThreadResult;
  readonly [REMOTE_HELPER_METHODS.providerRollbackThread]: RemoteHelperProviderReadThreadResult;
  readonly [REMOTE_HELPER_METHODS.providerStopSession]: void;
  readonly [REMOTE_HELPER_METHODS.providerListSessions]: ReadonlyArray<ProviderSession>;
  readonly [REMOTE_HELPER_METHODS.terminalOpen]: TerminalSessionSnapshot;
  readonly [REMOTE_HELPER_METHODS.terminalWrite]: void;
  readonly [REMOTE_HELPER_METHODS.terminalResize]: void;
  readonly [REMOTE_HELPER_METHODS.terminalClear]: void;
  readonly [REMOTE_HELPER_METHODS.terminalRestart]: TerminalSessionSnapshot;
  readonly [REMOTE_HELPER_METHODS.terminalClose]: void;
  readonly [REMOTE_HELPER_METHODS.workspaceSearchEntries]: ProjectSearchEntriesResult;
  readonly [REMOTE_HELPER_METHODS.workspaceBrowseEntries]: RemoteHelperBrowseEntriesResult;
  readonly [REMOTE_HELPER_METHODS.workspaceWriteFile]: { readonly relativePath: string };
  readonly [REMOTE_HELPER_METHODS.gitStatus]: GitStatusResult;
  readonly [REMOTE_HELPER_METHODS.gitPull]: GitPullResult;
  readonly [REMOTE_HELPER_METHODS.gitRunStackedAction]: GitRunStackedActionResult;
  readonly [REMOTE_HELPER_METHODS.gitListBranches]: GitListBranchesResult;
  readonly [REMOTE_HELPER_METHODS.gitCreateWorktree]: GitCreateWorktreeResult;
  readonly [REMOTE_HELPER_METHODS.gitRemoveWorktree]: void;
  readonly [REMOTE_HELPER_METHODS.gitCreateBranch]: void;
  readonly [REMOTE_HELPER_METHODS.gitCheckout]: void;
  readonly [REMOTE_HELPER_METHODS.gitInit]: void;
  readonly [REMOTE_HELPER_METHODS.checkpointIsGitRepository]: boolean;
  readonly [REMOTE_HELPER_METHODS.checkpointCapture]: void;
  readonly [REMOTE_HELPER_METHODS.checkpointHasRef]: boolean;
  readonly [REMOTE_HELPER_METHODS.checkpointRestore]: boolean;
  readonly [REMOTE_HELPER_METHODS.checkpointDiff]: string;
  readonly [REMOTE_HELPER_METHODS.checkpointDeleteRefs]: void;
}

export interface RemoteHelperMethodParams {
  readonly [REMOTE_HELPER_METHODS.hostPing]: undefined;
  readonly [REMOTE_HELPER_METHODS.hostGetCapabilities]: undefined;
  readonly [REMOTE_HELPER_METHODS.providerStartSession]: ProviderSessionStartInput;
  readonly [REMOTE_HELPER_METHODS.providerSendTurn]: ProviderSendTurnInput;
  readonly [REMOTE_HELPER_METHODS.providerInterruptTurn]: ProviderInterruptTurnInput;
  readonly [REMOTE_HELPER_METHODS.providerRespondToRequest]: ProviderRespondToRequestInput;
  readonly [REMOTE_HELPER_METHODS.providerRespondToUserInput]: ProviderRespondToUserInputInput;
  readonly [REMOTE_HELPER_METHODS.providerReadThread]: { readonly threadId: ThreadId };
  readonly [REMOTE_HELPER_METHODS.providerRollbackThread]: RemoteHelperProviderRollbackInput;
  readonly [REMOTE_HELPER_METHODS.providerStopSession]: { readonly threadId: ThreadId };
  readonly [REMOTE_HELPER_METHODS.providerListSessions]: undefined;
  readonly [REMOTE_HELPER_METHODS.terminalOpen]: TerminalOpenInput;
  readonly [REMOTE_HELPER_METHODS.terminalWrite]: TerminalWriteInput;
  readonly [REMOTE_HELPER_METHODS.terminalResize]: TerminalResizeInput;
  readonly [REMOTE_HELPER_METHODS.terminalClear]: TerminalClearInput;
  readonly [REMOTE_HELPER_METHODS.terminalRestart]: TerminalOpenInput;
  readonly [REMOTE_HELPER_METHODS.terminalClose]: TerminalCloseInput;
  readonly [REMOTE_HELPER_METHODS.workspaceSearchEntries]: { readonly cwd: string; readonly query: string; readonly limit: number };
  readonly [REMOTE_HELPER_METHODS.workspaceBrowseEntries]: RemoteHelperBrowseEntriesInput;
  readonly [REMOTE_HELPER_METHODS.workspaceWriteFile]: RemoteHelperWriteFileInput;
  readonly [REMOTE_HELPER_METHODS.gitStatus]: { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitPull]: { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitRunStackedAction]: Omit<GitRunStackedActionInput, "projectId" | "threadId"> & { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitListBranches]: { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitCreateWorktree]: Omit<GitCreateWorktreeInput, "projectId" | "threadId"> & { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitRemoveWorktree]: Omit<GitRemoveWorktreeInput, "projectId" | "threadId"> & { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitCreateBranch]: Omit<GitCreateBranchInput, "projectId" | "threadId"> & { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitCheckout]: Omit<GitCheckoutInput, "projectId" | "threadId"> & { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.gitInit]: Omit<GitInitInput, "projectId" | "threadId"> & { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.checkpointIsGitRepository]: { readonly cwd: string };
  readonly [REMOTE_HELPER_METHODS.checkpointCapture]: RemoteHelperCheckpointCaptureInput;
  readonly [REMOTE_HELPER_METHODS.checkpointHasRef]: RemoteHelperCheckpointHasRefInput;
  readonly [REMOTE_HELPER_METHODS.checkpointRestore]: RemoteHelperCheckpointRestoreInput;
  readonly [REMOTE_HELPER_METHODS.checkpointDiff]: RemoteHelperCheckpointDiffInput;
  readonly [REMOTE_HELPER_METHODS.checkpointDeleteRefs]: RemoteHelperCheckpointDeleteRefsInput;
}

export interface RemoteHostBoundNotification {
  readonly remoteHostId: RemoteHostId;
  readonly method: keyof RemoteHelperNotificationPayloads;
  readonly params: ProviderRuntimeEvent | TerminalEvent;
}
