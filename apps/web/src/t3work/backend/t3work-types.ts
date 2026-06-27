import type {
  ClientOrchestrationCommand,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type {
  DiscoverProjectRecipesRequest,
  DiscoverProjectRecipesResponse,
  LaunchProjectRecipeWorkflowRequest,
  LaunchProjectRecipeWorkflowResponse,
  SubmitProjectRecipeCardActionRequest,
  SubmitProjectRecipeCardActionResponse,
} from "@t3tools/project-recipes";
import type { AtlassianBackendApi } from "./t3work-atlassianBackendTypes";
import type { GitHubBackendApi } from "./t3work-githubBackendTypes";
import type { T3workTurnToolContext } from "~/t3work/t3work-threadToolContext";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface BackendState {
  readonly connectionStatus: ConnectionStatus;
  readonly serverConfig: ServerConfig | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly error: string | null;
}

export type T3workThreadPlacement = {
  readonly threadId: ThreadId;
  readonly parentThreadId?: ThreadId;
  readonly ticketId?: string;
};

export interface BackendApi {
  readonly state: BackendState;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly dispatchCommand: (command: ClientOrchestrationCommand) => Promise<void>;
  readonly launchRecipeWorkflow: (
    input: LaunchProjectRecipeWorkflowRequest,
  ) => Promise<LaunchProjectRecipeWorkflowResponse>;
  readonly submitRecipeCardAction: (
    input: SubmitProjectRecipeCardActionRequest,
  ) => Promise<SubmitProjectRecipeCardActionResponse>;
  /**
   * Answer a workflow's pending `askUser`: posts the user's reply as a real (visible) message on
   * the thread. The workflow-engine reactor resolves the parked `user.input` from that message
   * event — no separate agent turn is started, and there is a single resolution path.
   */
  readonly resolveWorkflowInput: (input: {
    readonly threadId: string;
    readonly text: string;
    /** The composer's optimistic message id, so the server message reconciles with it. */
    readonly messageId: string;
    /** Structured reply value (a decision-card choice); the server validates it against the
     * pending ask's affordance and the engine schema-validates it on resume. */
    readonly value?: unknown;
    /** The decision card's ask — rejected by the server if it is no longer the pending one. */
    readonly correlationId?: string;
  }) => Promise<void>;
  readonly listThreadPlacements: (input: {
    readonly threadIds?: ReadonlyArray<string>;
  }) => Promise<ReadonlyArray<T3workThreadPlacement>>;
  readonly syncThreadToolContext: (input: {
    readonly threadId: string;
    readonly toolContext?: T3workTurnToolContext | null;
  }) => Promise<void>;
  readonly atlassian: AtlassianBackendApi;
  readonly github: GitHubBackendApi;
  readonly projectWorkspace: ProjectWorkspaceBackendApi;
  readonly subscribeConfig: (listener: (event: ServerConfigStreamEvent) => void) => () => void;
  readonly subscribeLifecycle: (listener: (event: unknown) => void) => () => void;
  readonly subscribeShell: (listener: (event: unknown) => void) => () => void;
  readonly subscribeThread: (threadId: string, listener: (event: unknown) => void) => () => void;
}

export type LinkedRepositorySyncResult = {
  readonly url: string;
  readonly localPath: string;
  readonly status: "cloned" | "updated" | "failed";
  readonly error?: string;
};

export type ProjectWorkspaceBootstrapResult = {
  readonly workspaceRoot: string;
  readonly workspaceRepositoryInitialized: boolean;
  readonly referencesRoot: string;
  readonly linkedRepositories: ReadonlyArray<LinkedRepositorySyncResult>;
};

export type ProjectWorkspaceContextFile = {
  readonly relativePath: string;
  readonly contents: string;
  readonly encoding?: "utf8" | "base64";
};

export type ProjectWorkspaceWriteContextFilesResult = {
  readonly workspaceRoot: string;
  readonly writtenFiles: ReadonlyArray<string>;
};

export interface ProjectWorkspaceBackendApi {
  readonly bootstrapWorkspace: (input: {
    readonly workspaceRoot: string;
    readonly linkedRepositoryUrls?: ReadonlyArray<string>;
    readonly setupProfileId?: string;
    readonly customProfile?: import("@t3tools/t3work-skill-packs").T3WorkProfile;
  }) => Promise<ProjectWorkspaceBootstrapResult>;
  readonly discoverRecipes: (
    input: DiscoverProjectRecipesRequest,
  ) => Promise<DiscoverProjectRecipesResponse>;
  readonly writeContextFiles: (input: {
    readonly workspaceRoot: string;
    readonly files: ReadonlyArray<ProjectWorkspaceContextFile>;
  }) => Promise<ProjectWorkspaceWriteContextFilesResult>;
}

export type {
  GitHubBackendApi,
  GitHubInboxDiscoverResponse,
  GitHubInboxItem,
  GitHubRepositoryCandidate,
} from "./t3work-githubBackendTypes";

export type {
  AtlassianAssignableUser,
  AtlassianBacklogBoard,
  AtlassianBacklogBoardColumn,
  AtlassianBacklogBoardColumnStatus,
  AtlassianBacklogCapabilities,
  AtlassianBoardColumnsResponse,
  AtlassianBacklogResponse,
  AtlassianBacklogSavedFilter,
  AtlassianBacklogSprint,
  AtlassianBasicConnectInput,
  AtlassianDownloadedAsset,
  AtlassianOAuthConnectInput,
  AtlassianOAuthExchangeInput,
  AtlassianOAuthExchangeResult,
} from "./t3work-atlassianBackendTypes";

export interface T3WorkEnvironmentConnection {
  readonly environmentId: string;
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly dispose: () => Promise<void>;
}

export interface T3WorkBackend {
  readonly createEnvironmentConnection: (
    wsBaseUrl: string,
    httpBaseUrl: string,
  ) => Promise<T3WorkEnvironmentConnection>;
}

export interface T3WorkAuthState {
  status: "checking" | "authenticated" | "unauthenticated";
}

export interface T3WorkBackendProviderProps {
  readonly backend: T3WorkBackend;
  readonly children: React.ReactNode;
}

export interface T3WorkAuthProviderProps {
  readonly children: React.ReactNode;
}
