import type {
  ChangeRequestState,
  ChatAttachment,
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
  OrchestrationThreadShell,
  ProjectId,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderInfo,
  TerminalAttachStreamEvent,
  TerminalSessionSnapshot,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
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
  readonly list: Effect.Effect<ReadonlyArray<unknown>>;
}

export interface VcsCapability {
  readonly status: (input: { readonly cwd: string }) => Effect.Effect<unknown>;
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
   * List open GitHub pull requests for a head selector. This exposes the
   * existing GitHub CLI primitive; checks, reviews, and merge are not available
   * in the backing service and are intentionally omitted.
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
   * Create a GitHub pull request using a body file already present on disk.
   */
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, Error>;

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

export function definePlugin<const Definition extends PluginDefinition>(
  definition: Definition,
): Definition {
  return definition;
}
