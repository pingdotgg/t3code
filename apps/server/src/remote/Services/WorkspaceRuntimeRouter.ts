import type {
  CheckpointRef,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
  OpenInEditorInput,
  ProjectId,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
  ThreadId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProviderAdapterCapabilities } from "../../provider/Services/ProviderAdapter.ts";

export class WorkspaceRuntimeRouterError extends Schema.TaggedErrorClass<WorkspaceRuntimeRouterError>()(
  "WorkspaceRuntimeRouterError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

type RuntimeEffect<T> = Effect.Effect<T, WorkspaceRuntimeRouterError, never>;

export interface WorkspaceRuntimeRouterShape {
  readonly providerEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly subscribeTerminalEvents: (
    listener: (event: TerminalEvent) => void,
  ) => RuntimeEffect<() => void>;
  readonly projectSearchEntries: (
    input: ProjectSearchEntriesInput,
  ) => RuntimeEffect<ProjectSearchEntriesResult>;
  readonly projectWriteFile: (
    input: ProjectWriteFileInput,
  ) => RuntimeEffect<ProjectWriteFileResult>;
  readonly openInEditor: (input: OpenInEditorInput) => RuntimeEffect<void>;
  readonly gitStatus: (input: GitStatusInput) => RuntimeEffect<GitStatusResult>;
  readonly gitPull: (input: GitPullInput) => RuntimeEffect<GitPullResult>;
  readonly gitRunStackedAction: (
    input: GitRunStackedActionInput,
  ) => RuntimeEffect<GitRunStackedActionResult>;
  readonly gitListBranches: (
    input: GitListBranchesInput,
  ) => RuntimeEffect<GitListBranchesResult>;
  readonly gitCreateWorktree: (
    input: GitCreateWorktreeInput,
  ) => RuntimeEffect<GitCreateWorktreeResult>;
  readonly gitRemoveWorktree: (input: GitRemoveWorktreeInput) => RuntimeEffect<void>;
  readonly gitCreateBranch: (input: GitCreateBranchInput) => RuntimeEffect<void>;
  readonly gitCheckout: (input: GitCheckoutInput) => RuntimeEffect<void>;
  readonly gitInit: (input: GitInitInput) => RuntimeEffect<void>;
  readonly terminalOpen: (input: TerminalOpenInput) => RuntimeEffect<TerminalSessionSnapshot>;
  readonly terminalWrite: (input: TerminalWriteInput) => RuntimeEffect<void>;
  readonly terminalResize: (input: TerminalResizeInput) => RuntimeEffect<void>;
  readonly terminalClear: (input: TerminalClearInput) => RuntimeEffect<void>;
  readonly terminalRestart: (input: TerminalOpenInput) => RuntimeEffect<TerminalSessionSnapshot>;
  readonly terminalClose: (input: TerminalCloseInput) => RuntimeEffect<void>;
  readonly listProviderSessions: () => RuntimeEffect<ReadonlyArray<ProviderSession>>;
  readonly startProviderSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => RuntimeEffect<ProviderSession>;
  readonly getProviderCapabilities: (
    threadId: ThreadId,
    provider: ProviderKind,
  ) => RuntimeEffect<ProviderAdapterCapabilities>;
  readonly sendProviderTurn: (
    input: ProviderSendTurnInput,
  ) => RuntimeEffect<ProviderTurnStartResult>;
  readonly interruptProviderTurn: (input: ProviderInterruptTurnInput) => RuntimeEffect<void>;
  readonly respondToProviderRequest: (
    input: ProviderRespondToRequestInput,
  ) => RuntimeEffect<void>;
  readonly respondToProviderUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => RuntimeEffect<void>;
  readonly stopProviderSession: (threadId: ThreadId) => RuntimeEffect<void>;
  readonly rollbackProviderConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => RuntimeEffect<void>;
  readonly checkpointIsGitRepository: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
  }) => RuntimeEffect<boolean>;
  readonly checkpointCapture: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
  }) => RuntimeEffect<void>;
  readonly checkpointHasRef: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
  }) => RuntimeEffect<boolean>;
  readonly checkpointRestore: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
    readonly fallbackToHead?: boolean;
  }) => RuntimeEffect<boolean>;
  readonly checkpointDiff: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
    readonly fallbackFromToHead?: boolean;
  }) => RuntimeEffect<string>;
  readonly checkpointDeleteRefs: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  }) => RuntimeEffect<void>;
  readonly resolveProject: (projectId: ProjectId) => RuntimeEffect<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly executionTarget: "local" | "ssh-remote";
    readonly remoteHostId: string | null;
  }>;
}

export class WorkspaceRuntimeRouter extends ServiceMap.Service<
  WorkspaceRuntimeRouter,
  WorkspaceRuntimeRouterShape
>()("t3/remote/Services/WorkspaceRuntimeRouter") {}
