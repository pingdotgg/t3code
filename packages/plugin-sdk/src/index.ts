import type {
  ChangeRequestState,
  ChatAttachment,
  CheckpointRef,
  CommandId,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  MessageId,
  ModelSelection,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  ProjectId,
  RuntimeMode,
  ServerProvider,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderInfo,
  TerminalAttachStreamEvent,
  TerminalSessionSnapshot,
  ThreadId,
  TurnId,
  VcsCreateRefResult,
  VcsCreateWorktreeResult,
  VcsStatusResult,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Stream from "effect/Stream";

export type {
  PluginCapability,
  PluginId,
  PluginLockfile,
  PluginLockfilePlugin,
  PluginLockfileSource,
  PluginManifest,
  PluginManifestEntries,
  PluginState,
} from "@t3tools/contracts/plugin";
export { HOST_API_VERSION, hostApiSatisfies } from "@t3tools/contracts/plugin";

export type PluginRpcScope = "read" | "operate";
export type PluginReadiness = "requires-ready" | "always";

export interface PluginLogger {
  readonly debug: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
  readonly info: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
  readonly warn: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
  readonly error: (message: string, attributes?: Record<string, unknown>) => Effect.Effect<void>;
}

export interface PluginHostConfig {
  readonly appVersion: string;
  readonly hostApiVersion: string;
  readonly dataDir: string;
  readonly logger: PluginLogger;
}

export interface PluginCapabilityUnavailable {
  readonly _tag: "PluginCapabilityUnavailable";
  readonly capability: string;
  readonly message: string;
}

export interface AgentsCapability {
  /**
   * List configured provider instances visible to orchestration. Available
   * instances are returned as their public provider snapshots; unavailable
   * entries describe settings that this host cannot materialize.
   */
  readonly listInstances: () => Effect.Effect<AgentsListInstancesResult, Error>;

  /**
   * Create a plugin-owned orchestration thread. The host injects
   * `owner: "plugin:<id>"`; plugin input cannot choose or override owner.
   */
  readonly createThread: (
    input: AgentsCreateThreadInput,
  ) => Effect.Effect<AgentsCreateThreadResult, Error>;

  /**
   * Start a turn on a plugin-owned thread through the orchestration command
   * plane. `bootstrap.createThread`, when present, is owner-injected by the
   * host before dispatch.
   *
   * NOTE: the returned `turnId` is a SESSION-LOCAL handle for `awaitTurn`
   * within this server process's lifetime — it is not the durable projection
   * turn id and does not survive a server restart. Persist your own
   * correlation (the returned `messageId`, or observe the thread) if you need
   * to resolve a turn's outcome across restarts.
   */
  readonly startTurn: (input: AgentsStartTurnInput) => Effect.Effect<AgentsStartTurnResult, Error>;

  /**
   * Observe a plugin-owned thread using the same snapshot + thread-detail
   * event stream shape as `orchestration.subscribeThread`.
   */
  readonly observeThread: (
    threadId: ThreadId,
  ) => Stream.Stream<OrchestrationThreadStreamItem, Error>;

  /**
   * Wait for a projected turn row to reach `completed`, `error`, or
   * `interrupted`, then return the final assistant text if one was projected.
   * Timeout only fails this wait; it does not interrupt the provider turn.
   *
   * Accepts only a `turnId` returned by `startTurn` in the SAME server
   * lifetime (see the session-local note there). A `turnId` from a prior
   * process will not resolve and will time out.
   */
  readonly awaitTurn: (input: AgentsAwaitTurnInput) => Effect.Effect<AgentsAwaitTurnResult, Error>;

  /**
   * Convenience read for pending approval and user-input requests in
   * `thread.activities[]`. The same requests are also visible via
   * `observeThread` snapshots and events.
   */
  readonly listPendingRequests: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<AgentsPendingRequest>, Error>;

  /**
   * Respond to a provider approval request on a plugin-owned thread.
   */
  readonly respondToApproval: (input: AgentsRespondToApprovalInput) => Effect.Effect<void, Error>;

  /**
   * Respond to a provider user-input request on a plugin-owned thread.
   */
  readonly respondToUserInput: (input: AgentsRespondToUserInputInput) => Effect.Effect<void, Error>;

  /**
   * Request interruption of the active turn for a plugin-owned thread.
   */
  readonly interruptTurn: (input: AgentsInterruptTurnInput) => Effect.Effect<void, Error>;

  /**
   * Stop the provider session for a plugin-owned thread.
   */
  readonly stopSession: (input: AgentsThreadInput) => Effect.Effect<void, Error>;

  /**
   * Delete a plugin-owned thread.
   */
  readonly deleteThread: (input: AgentsThreadInput) => Effect.Effect<void, Error>;
}

export interface VcsCapability {
  /**
   * Read Git status for an absolute repository or worktree path.
   *
   * VCS is a full-trust capability: the host validates paths are absolute, but
   * does not scope them to plugin data. Plugins should operate in their own
   * worktrees.
   */
  readonly status: (input: VcsWorktreeInput) => Effect.Effect<VcsStatusResult, Error>;

  /**
   * List Git worktrees for an absolute repository root.
   */
  readonly listWorktrees: (input: VcsRepoInput) => Effect.Effect<VcsListWorktreesResult, Error>;

  /**
   * Create a Git worktree for a ref. No lease concept is exposed because the
   * backing VCS layer does not implement leases.
   */
  readonly createWorktree: (
    input: VcsCreateWorktreeFacadeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, Error>;

  /**
   * Remove a Git worktree by absolute path.
   */
  readonly removeWorktree: (input: VcsRemoveWorktreeFacadeInput) => Effect.Effect<void, Error>;

  /**
   * Create a local branch and optionally switch to it.
   */
  readonly createBranch: (input: VcsCreateBranchInput) => Effect.Effect<VcsCreateRefResult, Error>;

  /**
   * Switch the current worktree to a local or remote ref.
   */
  readonly switchRef: (input: VcsSwitchRefFacadeInput) => Effect.Effect<VcsSwitchRefResult, Error>;

  /**
   * Remove a tracked path from the index and working tree. Missing paths are
   * ignored by the backing Git command.
   */
  readonly removePath: (input: VcsPathInput) => Effect.Effect<void, Error>;

  /**
   * Remove untracked files and directories at a path.
   */
  readonly clean: (input: VcsPathInput) => Effect.Effect<void, Error>;

  /**
   * Read the current branch name, or "HEAD" when detached.
   */
  readonly currentBranch: (input: VcsWorktreeInput) => Effect.Effect<string, Error>;

  /**
   * Count commits reachable from `head` but not `base`.
   */
  readonly aheadCount: (input: VcsAheadCountInput) => Effect.Effect<number, Error>;

  /**
   * List local and remote refs for a repository root.
   */
  readonly listRefs: (input: VcsRepoInput) => Effect.Effect<ReadonlyArray<VcsRef>, Error>;

  /**
   * Stage selected paths, or all changes when `filePaths` is omitted, then
   * create a commit. No-change commits are surfaced as a skipped value.
   */
  readonly commit: (input: VcsCommitInput) => Effect.Effect<VcsCommitResult, Error>;

  /**
   * Merge a ref into the current worktree. Merge conflicts are returned as
   * `{ status: "conflict" }` instead of being thrown.
   */
  readonly merge: (input: VcsMergeInput) => Effect.Effect<VcsMergeResult, Error>;

  /**
   * Push the current branch when the Git driver can resolve a remote.
   */
  readonly push: (input: VcsPushInput) => Effect.Effect<VcsPushResult, Error>;

  /**
   * Read the working-tree patch for an absolute worktree path.
   */
  readonly workingTreeDiff: (input: VcsWorkingTreeDiffInput) => Effect.Effect<VcsDiffResult, Error>;

  /**
   * Read a patch between two refs.
   */
  readonly diffRefs: (input: VcsDiffRefsInput) => Effect.Effect<VcsDiffResult, Error>;

  /**
   * Capture a filesystem checkpoint at a caller-provided Git ref.
   */
  readonly createCheckpoint: (input: VcsCheckpointInput) => Effect.Effect<void, Error>;

  /**
   * Check whether a checkpoint ref exists. The backing CheckpointStore has no
   * list operation, so the SDK intentionally exposes existence checks instead
   * of inventing checkpoint listing.
   */
  readonly hasCheckpoint: (input: VcsCheckpointInput) => Effect.Effect<boolean, Error>;

  /**
   * Restore workspace and staging state from a checkpoint ref.
   */
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<VcsRestoreCheckpointResult, Error>;

  /**
   * Delete checkpoint refs. Missing refs are tolerated by the backing store.
   */
  readonly deleteCheckpoints: (input: VcsDeleteCheckpointsInput) => Effect.Effect<void, Error>;
}

export interface TerminalsCapability {
  /**
   * Open a plugin-owned shell terminal and write the requested command line.
   *
   * The server terminal manager exposes PTY shell sessions, not raw process
   * handles, so command execution is shell-backed. `env` is passed to the shell
   * session and `args` are shell-quoted before the first write.
   */
  readonly spawn: (input: TerminalSpawnInput) => Effect.Effect<TerminalSpawnResult, Error>;

  /**
   * Attach to a plugin terminal and receive its initial snapshot plus live
   * output/lifecycle events. The returned function unsubscribes the listener.
   */
  readonly observe: (
    input: TerminalSessionHandle,
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void, Error>;

  /**
   * Write raw input to a running plugin terminal session.
   */
  readonly sendInput: (
    input: TerminalSessionHandle & { readonly data: string },
  ) => Effect.Effect<void, Error>;

  /**
   * Close a plugin terminal session. This maps to the server terminal close
   * operation and does not expose UI resize/clear metadata controls.
   */
  readonly kill: (
    input: TerminalSessionHandle & { readonly deleteHistory?: boolean },
  ) => Effect.Effect<void, Error>;
}

export interface DatabaseCapability {
  /**
   * The raw Effect SqlClient bound to the shared database. Full-trust: runtime
   * SQL is unpoliced (the p_<id>_ namespace gate is migration-time only), so
   * this grants no power beyond `execute`. Provided for plugins whose ported
   * code uses tagged-template SQL / composable fragments / withTransaction.
   */
  readonly client: SqlClient.SqlClient;

  /**
   * Execute trusted plugin SQL and return decoded row objects.
   *
   * Plugin tables are namespaced by convention as `p_<plugin_id>_*`. Runtime
   * queries are not policed: plugins run with full SQL trust. The migration
   * gate is the only enforcement point for database namespace rules.
   */
  readonly execute: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, Error>;

  /**
   * Run an Effect inside the shared SQL client's transaction boundary.
   */
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Error, R>;
}

export interface ProjectionsReadCapability {
  /**
   * Read a single active thread shell by id. The lookup is intentionally
   * id-keyed and not owner-filtered.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadShell | null, Error>;

  /**
   * Read a single active thread detail snapshot by id. The lookup is
   * intentionally id-keyed and not owner-filtered.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThread | null, Error>;

  /**
   * List projected turn rows for a thread, including pending placeholders.
   */
  readonly listTurnsByThreadId: (input: {
    readonly threadId: ThreadId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ProjectionTurnRecord>, Error>;

  /**
   * List projected thread messages in creation order with a bounded result cap.
   */
  readonly listMessagesByThreadId: (input: {
    readonly threadId: ThreadId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<OrchestrationMessage>, Error>;

  /**
   * Read a projected thread message directly by message id.
   */
  readonly getMessageById: (
    messageId: MessageId,
  ) => Effect.Effect<OrchestrationMessage | null, Error>;

  /**
   * List projected thread activities in runtime sequence order with a bounded
   * result cap.
   */
  readonly listActivitiesByThreadId: (input: {
    readonly threadId: ThreadId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, Error>;
}

export interface EnvironmentsReadCapability {
  /**
   * Read the stable server environment id.
   */
  readonly getEnvironmentId: Effect.Effect<EnvironmentId, Error>;

  /**
   * Read the current execution environment descriptor.
   */
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor, Error>;

  /**
   * List active project shells from the orchestration projection.
   */
  readonly listProjects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, Error>;

  /**
   * Read a single active project shell by id.
   */
  readonly getProjectById: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | null, Error>;

  /**
   * Resolve an active project by exact workspace root.
   */
  readonly resolveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<OrchestrationProject | null, Error>;
}

export interface SecretsCapability {
  /**
   * Read a plugin-scoped secret. The host prepends `plugin:<id>:` and strips it
   * from returned names, so plugins cannot address keys outside their prefix.
   */
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, Error>;

  /**
   * Set a plugin-scoped secret under the enforced `plugin:<id>:` key prefix.
   */
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, Error>;

  /**
   * Delete a plugin-scoped secret. Missing keys are treated as already deleted.
   */
  readonly delete: (name: string) => Effect.Effect<void, Error>;

  /**
   * List plugin-scoped secret names with the enforced prefix stripped.
   */
  readonly list: Effect.Effect<ReadonlyArray<string>, Error>;
}

export interface HttpCapability {
  /**
   * Base path for this plugin's registered HTTP hooks.
   *
   * Routes are mounted under `/hooks/plugins/<pluginId>/...` and are only
   * registered when the plugin declares the `http` capability.
   */
  readonly basePath: string;
}

export interface FilesystemPathInput {
  readonly root: string;
  readonly relativePath: string;
}

export interface FilesystemRenameInput {
  readonly root: string;
  readonly fromRelativePath: string;
  readonly toRelativePath: string;
}

export interface FileStat {
  readonly type: "file" | "directory" | "other";
  readonly size: number;
  readonly mtime: number;
}

export interface DirEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly type: "file" | "directory" | "other";
}

export interface FilesystemCapability {
  /**
   * List currently granted absolute roots. This includes active project
   * workspaces plus worktrees this plugin created through the VCS capability.
   */
  readonly listRoots: () => Effect.Effect<ReadonlyArray<string>, Error>;

  /**
   * Read a file as bytes. The host enforces a 16 MiB hard cap.
   */
  readonly readFile: (input: FilesystemPathInput) => Effect.Effect<Uint8Array, Error>;

  /**
   * Read a UTF-8 file as a string. The host enforces a 16 MiB hard cap.
   */
  readonly readFileString: (input: FilesystemPathInput) => Effect.Effect<string, Error>;

  /**
   * Read at most maxBytes from a UTF-8 file as a string.
   */
  readonly readFileStringCapped: (
    input: FilesystemPathInput & { readonly maxBytes: number },
  ) => Effect.Effect<string, Error>;

  /**
   * Write bytes to a file, creating missing parent directories after each
   * parent has been validated inside the granted root.
   */
  readonly writeFile: (
    input: FilesystemPathInput & { readonly contents: Uint8Array },
  ) => Effect.Effect<void, Error>;

  /**
   * Write a UTF-8 string to a file.
   */
  readonly writeFileString: (
    input: FilesystemPathInput & { readonly contents: string },
  ) => Effect.Effect<void, Error>;

  /**
   * Create a file and fail if the final path already exists.
   */
  readonly createFileExclusive: (
    input: FilesystemPathInput & { readonly contents: string | Uint8Array },
  ) => Effect.Effect<void, Error>;

  /**
   * Test whether a path exists within a granted root.
   */
  readonly exists: (input: FilesystemPathInput) => Effect.Effect<boolean, Error>;

  /**
   * Read file metadata.
   */
  readonly stat: (input: FilesystemPathInput) => Effect.Effect<FileStat, Error>;

  /**
   * List direct directory children.
   */
  readonly listDir: (input: FilesystemPathInput) => Effect.Effect<ReadonlyArray<DirEntry>, Error>;

  /**
   * Recursively list directory children. The host caps results at 500 entries.
   */
  readonly listDirRecursive: (
    input: FilesystemPathInput,
  ) => Effect.Effect<ReadonlyArray<DirEntry>, Error>;

  /**
   * Create a directory path segment by segment after validating each parent.
   */
  readonly makeDirectory: (input: FilesystemPathInput) => Effect.Effect<void, Error>;

  /**
   * Remove a file or directory. Missing paths are treated as already removed.
   */
  readonly remove: (input: FilesystemPathInput) => Effect.Effect<void, Error>;

  /**
   * Rename within a granted root. Cross-root renames and overwrites are rejected.
   */
  readonly rename: (input: FilesystemRenameInput) => Effect.Effect<void, Error>;
}

export interface HttpClientRequestInput {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface HttpClientResponseResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface HttpClientCapability {
  /**
   * Make an outbound request. The host allows public HTTPS targets by default,
   * does not follow redirects, caps responses to 8 MiB by default / 32 MiB
   * hard, and caps timeouts to 30s by default / 120s hard.
   */
  readonly request: (
    input: HttpClientRequestInput,
  ) => Effect.Effect<HttpClientResponseResult, Error>;

  /**
   * Request JSON and parse the response body.
   */
  readonly requestJson: <A = unknown>(
    input: Omit<HttpClientRequestInput, "body"> & { readonly body?: unknown },
  ) => Effect.Effect<A, Error>;

  /**
   * Convenience JSON GET wrapper.
   */
  readonly getJson: <A = unknown>(
    url: string,
    input?: Omit<HttpClientRequestInput, "method" | "url" | "body">,
  ) => Effect.Effect<A, Error>;
}

export interface SourceControlCapability {
  /**
   * Detect the source-control provider context for a repository root.
   */
  readonly detectProvider: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProviderDetectionResult, Error>;

  /**
   * List configured source-control providers and auth availability.
   */
  readonly discoverProviders: Effect.Effect<
    ReadonlyArray<SourceControlProviderDiscoveryItem>,
    Error
  >;

  /**
   * List open GitHub pull requests for a head selector.
   */
  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, Error>;

  /**
   * Read GitHub pull request details by number, URL, or branch reference.
   */
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitHubPullRequestSummary, Error>;

  /**
   * Read repository clone URLs from GitHub.
   */
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitHubRepositoryCloneUrls, Error>;

  /**
   * Create a GitHub pull request using a body file already present on disk.
   */
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
    readonly draft?: boolean | undefined;
  }) => Effect.Effect<void, Error>;

  /**
   * Merge a GitHub pull request with the selected strategy.
   */
  readonly mergePullRequest: (input: {
    readonly cwd: string;
    readonly number: number;
    readonly strategy: GitHubMergeStrategy;
  }) => Effect.Effect<void, Error>;

  /**
   * Read raw GitHub pull request detail fields.
   */
  readonly getPullRequestDetail: (input: {
    readonly cwd: string;
    readonly number: number;
  }) => Effect.Effect<GitHubPullRequestDetail, Error>;

  /**
   * List raw GitHub pull request check rows.
   */
  readonly listPullRequestChecks: (input: {
    readonly cwd: string;
    readonly number: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestCheck>, Error>;

  /**
   * List raw GitHub pull request reviews.
   */
  readonly listPullRequestReviews: (input: {
    readonly cwd: string;
    readonly number: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestReview>, Error>;

  /**
   * List raw GitHub pull request review comments.
   */
  readonly listPullRequestReviewComments: (input: {
    readonly cwd: string;
    readonly repo: string;
    readonly number: number;
  }) => Effect.Effect<ReadonlyArray<GitHubPullRequestReviewComment>, Error>;

  /**
   * Read the default branch reported by the GitHub CLI for the current repo.
   */
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, Error>;

  /**
   * Check out a GitHub pull request by number, URL, or branch reference.
   */
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, Error>;
}

export interface TextGenerationCapability {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, Error>;

  /**
   * Generate pull request title/body content from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, Error>;

  /**
   * Generate a concise branch name from a user message and optional
   * attachments.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, Error>;

  /**
   * Generate a concise thread title from a user's first message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, Error>;
}

export interface TerminalSessionHandle {
  readonly threadId: string;
  readonly terminalId: string;
}

export interface TerminalSpawnInput {
  readonly cwd: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly terminalId?: string | undefined;
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
}

export interface TerminalSpawnResult {
  readonly handle: TerminalSessionHandle;
  readonly snapshot: TerminalSessionSnapshot;
}

export interface ProjectionTurnRecord {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly pendingMessageId: MessageId | null;
  readonly sourceProposedPlanThreadId: ThreadId | null;
  readonly sourceProposedPlanId: string | null;
  readonly assistantMessageId: MessageId | null;
  readonly state: "pending" | "running" | "interrupted" | "completed" | "error";
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly checkpointTurnCount: number | null;
  readonly checkpointRef: string | null;
  readonly checkpointStatus: OrchestrationCheckpointStatus | null;
  readonly checkpointFiles: ReadonlyArray<OrchestrationCheckpointFile>;
}

export interface AgentsListInstancesResult {
  readonly available: ReadonlyArray<ServerProvider>;
  readonly unavailable: ReadonlyArray<ServerProvider>;
}

export interface AgentsCreateThreadInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}

export interface AgentsCreateThreadResult {
  readonly threadId: ThreadId;
}

export interface AgentsBootstrapCreateThreadInput extends AgentsCreateThreadInput {
  readonly createdAt?: string | undefined;
}

export interface AgentsStartTurnBootstrapInput {
  readonly createThread?: AgentsBootstrapCreateThreadInput | undefined;
  readonly prepareWorktree?:
    | {
        readonly projectCwd: string;
        readonly baseBranch: string;
        readonly branch?: string | undefined;
        readonly startFromOrigin?: boolean | undefined;
      }
    | undefined;
  readonly runSetupScript?: boolean | undefined;
}

export interface AgentsStartTurnInput {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly messageId?: MessageId | undefined;
  readonly commandId?: CommandId | undefined;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly bootstrap?: AgentsStartTurnBootstrapInput | undefined;
}

export interface AgentsStartTurnResult {
  readonly turnId: TurnId;
  readonly messageId: MessageId;
}

export interface AgentsAwaitTurnInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly timeout?: string | number | undefined;
}

export interface AgentsAwaitTurnResult {
  readonly state: "completed" | "error" | "interrupted";
  readonly assistantText: string | null;
  readonly stopReason?: string | undefined;
  readonly errorMessage?: string | undefined;
}

export interface AgentsPendingRequest {
  readonly kind: "approval.requested" | "user-input.requested";
  readonly requestId: string;
  readonly activity: OrchestrationThreadActivity;
}

export interface AgentsThreadInput {
  readonly threadId: ThreadId;
}

export interface AgentsInterruptTurnInput extends AgentsThreadInput {
  readonly turnId?: TurnId | undefined;
}

export interface AgentsRespondToApprovalInput extends AgentsThreadInput {
  readonly requestId: string;
  readonly decision: ProviderApprovalDecision;
}

export interface AgentsRespondToUserInputInput extends AgentsThreadInput {
  readonly requestId: string;
  readonly answers: ProviderUserInputAnswers;
}

export interface VcsRepoInput {
  readonly repoRoot: string;
}

export interface VcsWorktreeInput {
  readonly worktreePath: string;
}

export interface VcsPathInput extends VcsWorktreeInput {
  readonly path: string;
}

export interface VcsAheadCountInput extends VcsWorktreeInput {
  readonly base: string;
  readonly head: string;
}

export interface VcsWorktreeSummary {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
}

export interface VcsListWorktreesResult {
  readonly worktrees: ReadonlyArray<VcsWorktreeSummary>;
}

export interface VcsCreateWorktreeFacadeInput extends VcsRepoInput {
  readonly ref: string;
  readonly path: string;
  readonly newBranch?: string | undefined;
  readonly baseRef?: string | undefined;
}

export interface VcsRemoveWorktreeFacadeInput extends VcsRepoInput {
  readonly path: string;
  readonly force?: boolean | undefined;
}

export interface VcsCreateBranchInput extends VcsWorktreeInput {
  readonly branch: string;
  readonly switch?: boolean | undefined;
}

export interface VcsSwitchRefFacadeInput extends VcsWorktreeInput {
  readonly ref: string;
}

export interface VcsRef {
  readonly name: string;
  readonly isRemote: boolean;
  readonly worktreePath: string | null;
}

export interface VcsCommitInput extends VcsWorktreeInput {
  readonly subject: string;
  readonly body?: string | undefined;
  readonly filePaths?: ReadonlyArray<string> | undefined;
  readonly noVerify?: boolean | undefined;
}

export type VcsCommitResult =
  | {
      readonly status: "created";
      readonly commitSha: string;
    }
  | {
      readonly status: "skipped_no_changes";
    };

export interface VcsMergeInput extends VcsWorktreeInput {
  readonly ref: string;
  readonly message?: string | undefined;
  readonly noFf?: boolean | undefined;
  readonly noVerify?: boolean | undefined;
  readonly abortOnConflict?: boolean | undefined;
}

export type VcsMergeResult =
  | {
      readonly status: "merged";
      readonly commitSha: string;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: "conflict";
      readonly conflictedFiles: ReadonlyArray<string>;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface VcsPushInput extends VcsWorktreeInput {
  readonly fallbackBranch?: string | null | undefined;
  readonly remoteName?: string | null | undefined;
}

export interface VcsPushResult {
  readonly status: "pushed" | "skipped_up_to_date";
  readonly branch: string;
  readonly upstreamBranch?: string | undefined;
  readonly setUpstream?: boolean | undefined;
}

export interface VcsWorkingTreeDiffInput extends VcsWorktreeInput {
  readonly staged?: boolean | undefined;
  readonly ignoreWhitespace?: boolean | undefined;
}

export interface VcsDiffRefsInput extends VcsWorktreeInput {
  readonly fromRef: string;
  readonly toRef: string;
  readonly ignoreWhitespace?: boolean | undefined;
}

export interface VcsDiffResult {
  readonly diff: string;
}

export interface VcsCheckpointInput extends VcsWorktreeInput {
  readonly checkpointRef: CheckpointRef;
}

export interface VcsRestoreCheckpointInput extends VcsCheckpointInput {
  readonly fallbackToHead?: boolean | undefined;
}

export interface VcsRestoreCheckpointResult {
  readonly restored: boolean;
}

export interface VcsDeleteCheckpointsInput extends VcsWorktreeInput {
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface SourceControlProviderDetectionResult {
  readonly provider: SourceControlProviderInfo | null;
  readonly remoteName: string | null;
  readonly remoteUrl: string | null;
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: ChangeRequestState | undefined;
  readonly isCrossRepository?: boolean | undefined;
  readonly headRepositoryNameWithOwner?: string | null | undefined;
  readonly headRepositoryOwnerLogin?: string | null | undefined;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export type GitHubMergeStrategy = "squash" | "merge" | "rebase";

export interface GitHubPullRequestDetail {
  readonly state: string;
  readonly mergedAt: string | null;
  readonly reviewDecision: string | null;
  readonly headRefOid: string;
  readonly url: string;
}

export interface GitHubPullRequestCheck {
  readonly name: string;
  readonly state: string;
  readonly bucket: string;
  readonly link: string;
}

export interface GitHubPullRequestReview {
  readonly id: string;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string;
}

export interface GitHubPullRequestReviewComment {
  readonly id: number;
  readonly user: string;
  readonly body: string;
  readonly path: string | null;
  readonly createdAt: string;
}

export interface CommitMessageGenerationInput {
  readonly cwd: string;
  readonly branch: string | null;
  readonly stagedSummary: string;
  readonly stagedPatch: string;
  readonly includeBranch?: boolean;
  readonly modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  readonly subject: string;
  readonly body: string;
  readonly branch?: string | undefined;
}

export interface PrContentGenerationInput {
  readonly cwd: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly commitSummary: string;
  readonly diffSummary: string;
  readonly diffPatch: string;
  readonly modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  readonly title: string;
  readonly body: string;
}

export interface BranchNameGenerationInput {
  readonly cwd: string;
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  readonly branch: string;
}

export interface ThreadTitleGenerationInput {
  readonly cwd: string;
  readonly message: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  readonly title: string;
}

export interface PluginHostApi {
  readonly hostApiVersion: string;
  readonly config: PluginHostConfig;
  readonly agents: Effect.Effect<AgentsCapability, PluginCapabilityUnavailable>;
  readonly vcs: Effect.Effect<VcsCapability, PluginCapabilityUnavailable>;
  readonly terminals: Effect.Effect<TerminalsCapability, PluginCapabilityUnavailable>;
  readonly database: Effect.Effect<DatabaseCapability, PluginCapabilityUnavailable>;
  readonly projectionsRead: Effect.Effect<ProjectionsReadCapability, PluginCapabilityUnavailable>;
  readonly environmentsRead: Effect.Effect<EnvironmentsReadCapability, PluginCapabilityUnavailable>;
  readonly secrets: Effect.Effect<SecretsCapability, PluginCapabilityUnavailable>;
  readonly http: Effect.Effect<HttpCapability, PluginCapabilityUnavailable>;
  readonly filesystem: Effect.Effect<FilesystemCapability, PluginCapabilityUnavailable>;
  readonly httpClient: Effect.Effect<HttpClientCapability, PluginCapabilityUnavailable>;
  readonly sourceControl: Effect.Effect<SourceControlCapability, PluginCapabilityUnavailable>;
  readonly textGeneration: Effect.Effect<TextGenerationCapability, PluginCapabilityUnavailable>;
}

export interface PluginRpcContext {
  readonly pluginId: string;
  readonly logger: PluginLogger;
}

export interface PluginRpcDescriptor {
  readonly method: string;
  readonly scope: PluginRpcScope;
  readonly readiness?: PluginReadiness | undefined;
  readonly handler: (payload: unknown, ctx: PluginRpcContext) => Effect.Effect<unknown, Error>;
}

export interface PluginStreamDescriptor {
  readonly method: string;
  readonly scope: PluginRpcScope;
  readonly readiness?: PluginReadiness | undefined;
  readonly handler: (payload: unknown, ctx: PluginRpcContext) => Stream.Stream<unknown, Error>;
}

export interface PluginHttpDescriptor {
  /** HTTP method to match, for example `GET` or `POST`. */
  readonly method: string;
  /** Plugin-local route path, with `:param` segments supported. */
  readonly path: string;
  /** Public routes skip auth; token routes require `plugin:<id>:operate`. */
  readonly auth: "public" | "token";
  /**
   * Maximum request body size in bytes. Defaults to 1 MiB and is capped by the
   * host at 8 MiB.
   */
  readonly maxBodyBytes?: number | undefined;
  /** Handle a matched HTTP request and return a serializable response. */
  readonly handler: (
    request: PluginHttpRequest,
    ctx: PluginRpcContext,
  ) => Effect.Effect<PluginHttpResponse, Error>;
}

export interface PluginHttpRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

export interface PluginHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?:
    | string
    | Uint8Array
    | ReadonlyArray<unknown>
    | Readonly<Record<string, unknown>>
    | null;
}

export interface PluginServiceContext {
  readonly pluginId: string;
  readonly logger: PluginLogger;
}

export interface PluginServiceDescriptor {
  readonly name: string;
  readonly run: (ctx: PluginServiceContext) => Effect.Effect<void, Error>;
}

export interface PluginMigration {
  readonly version: number;
  readonly name: string;
  readonly up: Effect.Effect<void, Error, SqlClient.SqlClient>;
}

export interface PluginRegistration {
  readonly migrations?: ReadonlyArray<PluginMigration> | undefined;
  readonly recover?: (() => Effect.Effect<void, Error>) | undefined;
  readonly rpc?: ReadonlyArray<PluginRpcDescriptor> | undefined;
  readonly streams?: ReadonlyArray<PluginStreamDescriptor> | undefined;
  readonly http?: ReadonlyArray<PluginHttpDescriptor> | undefined;
  readonly services?: ReadonlyArray<PluginServiceDescriptor> | undefined;
}

export interface PluginDefinition {
  readonly register:
    | ((hostApi: PluginHostApi) => Effect.Effect<PluginRegistration, Error>)
    | ((hostApi: PluginHostApi) => Promise<PluginRegistration>)
    | ((hostApi: PluginHostApi) => PluginRegistration);
}

export function writeFileAtomic(
  filesystem: Pick<FilesystemCapability, "writeFile" | "rename" | "remove">,
  input: FilesystemPathInput & { readonly contents: string | Uint8Array },
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const segments = input.relativePath.split("/");
    const fileName = segments.pop() ?? "file";
    const now = yield* Clock.currentTimeMillis;
    const random = Math.abs(yield* Random.nextInt);
    const tempName = `.${fileName}.${now.toString(36)}-${random.toString(36)}.tmp`;
    const tempRelativePath = [...segments, tempName]
      .filter((segment) => segment.length > 0)
      .join("/");
    const contents =
      typeof input.contents === "string"
        ? new TextEncoder().encode(input.contents)
        : input.contents;

    return yield* filesystem
      .writeFile({
        root: input.root,
        relativePath: tempRelativePath,
        contents,
      })
      .pipe(
        Effect.andThen(
          filesystem.rename({
            root: input.root,
            fromRelativePath: tempRelativePath,
            toRelativePath: input.relativePath,
          }),
        ),
        Effect.catch((error) =>
          filesystem
            .remove({ root: input.root, relativePath: tempRelativePath })
            .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
        ),
      );
  });
}

export function definePlugin<const Definition extends PluginDefinition>(
  definition: Definition,
): Definition {
  return definition;
}
