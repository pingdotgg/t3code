import type {
  GitCheckoutInput,
  GitCloneRepoInput,
  GitCloneRepoResult,
  GitSetBranchUpstreamInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitDiffBranchInput,
  GitDiffBranchResult,
  GitDiffWorkingTreeInput,
  GitFetchPrDetailsInput,
  GitFetchPrDetailsResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitListOpenPrsInput,
  GitListOpenPrsResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type { ServerConfig } from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ServerUpsertKeybindingInput, ServerUpsertKeybindingResult } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "./orchestration";
import type {
  JiraIssueViewInput,
  JiraIssueViewResult,
  JiraIssueCreateInput,
  JiraIssueCreateResult,
  JiraIssueMoveInput,
  JiraIssueMoveResult,
  JiraCommentAddInput,
  JiraCommentAddResult,
  JiraIssueListInput,
  JiraIssueListResult,
  JiraListTransitionsInput,
  JiraListTransitionsResult,
  JiraGenerateTicketContentInput,
  JiraGenerateTicketContentResult,
  JiraGenerateProgressCommentInput,
  JiraGenerateProgressCommentResult,
} from "./jira";
import { EditorId, type OpenInWarpInput } from "./editor";
import type {
  ReviewCommentAddInput,
  ReviewCommentAddResult,
  ReviewCommentUpdateInput,
  ReviewCommentDeleteInput,
  ReviewCommentListInput,
  ReviewCommentListResult,
  ReviewCommentPublishInput,
  ReviewCommentPublishResult,
} from "./reviewComment";
import type {
  ReviewRequestListInput,
  ReviewRequestListResult,
  ReviewRequestDismissInput,
  ReviewRequestLinkThreadInput,
  ReviewRequestSubmitInput,
} from "./reviewRequest";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openInWarp: (input: OpenInWarpInput) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
    // Diff API
    diffBranch: (input: GitDiffBranchInput) => Promise<GitDiffBranchResult>;
    diffWorkingTree: (input: GitDiffWorkingTreeInput) => Promise<GitDiffBranchResult>;
    // Clone API
    cloneRepo: (input: GitCloneRepoInput) => Promise<GitCloneRepoResult>;
    setBranchUpstream: (input: GitSetBranchUpstreamInput) => Promise<void>;
    // GitHub PR API
    fetchPrDetails: (input: GitFetchPrDetailsInput) => Promise<GitFetchPrDetailsResult>;
    listOpenPrs: (input: GitListOpenPrsInput) => Promise<GitListOpenPrsResult>;
  };
  jira: {
    isConfigured: () => Promise<{ configured: boolean }>;
    viewIssue: (input: JiraIssueViewInput) => Promise<JiraIssueViewResult>;
    createIssue: (input: JiraIssueCreateInput) => Promise<JiraIssueCreateResult>;
    moveIssue: (input: JiraIssueMoveInput) => Promise<JiraIssueMoveResult>;
    addComment: (input: JiraCommentAddInput) => Promise<JiraCommentAddResult>;
    listIssues: (input: JiraIssueListInput) => Promise<JiraIssueListResult>;
    listTransitions: (input: JiraListTransitionsInput) => Promise<JiraListTransitionsResult>;
    generateTicketContent: (
      input: JiraGenerateTicketContentInput,
    ) => Promise<JiraGenerateTicketContentResult>;
    generateProgressComment: (
      input: JiraGenerateProgressCommentInput,
    ) => Promise<JiraGenerateProgressCommentResult>;
  };
  reviewComment: {
    add: (input: ReviewCommentAddInput) => Promise<ReviewCommentAddResult>;
    update: (input: ReviewCommentUpdateInput) => Promise<void>;
    delete: (input: ReviewCommentDeleteInput) => Promise<void>;
    list: (input: ReviewCommentListInput) => Promise<ReviewCommentListResult>;
    publish: (input: ReviewCommentPublishInput) => Promise<ReviewCommentPublishResult>;
  };
  reviewRequest: {
    list: (input: ReviewRequestListInput) => Promise<ReviewRequestListResult>;
    dismiss: (input: ReviewRequestDismissInput) => Promise<void>;
    linkThread: (input: ReviewRequestLinkThreadInput) => Promise<void>;
    submit: (input: ReviewRequestSubmitInput) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
