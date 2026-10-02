import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusResult,
  type GitStatusStreamEvent,
  type LocalApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@t3tools/contracts";
import type {
  CollaborativeAcceptanceAssessmentSubmission,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceCandidateSubmission,
  CollaborativeAcceptancePauseReason,
  ThreadId,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import { Effect, Stream } from "effect";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
}

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

type RpcInputStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (
        input: RpcInput<TTag>,
        listener: (event: TEvent) => void,
        options?: StreamSubscriptionOptions,
      ) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly sidebar: {
    readonly getState: RpcUnaryNoArgMethod<typeof WS_METHODS.sidebarGetState>;
    readonly updateState: RpcUnaryMethod<typeof WS_METHODS.sidebarUpdateState>;
    readonly onState: RpcStreamMethod<typeof WS_METHODS.subscribeSidebarState>;
  };
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly listEntries: RpcUnaryMethod<typeof WS_METHODS.projectsListEntries>;
    readonly readFile: RpcUnaryMethod<typeof WS_METHODS.projectsReadFile>;
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
  };
  readonly assets: {
    readonly createUrl: RpcUnaryMethod<typeof WS_METHODS.assetsCreateUrl>;
  };
  readonly preview: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.previewOpen>;
    readonly navigate: RpcUnaryMethod<typeof WS_METHODS.previewNavigate>;
    readonly reportStatus: RpcUnaryMethod<typeof WS_METHODS.previewReportStatus>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.previewResize>;
    readonly refresh: RpcUnaryMethod<typeof WS_METHODS.previewRefresh>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.previewClose>;
    readonly list: RpcUnaryMethod<typeof WS_METHODS.previewList>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribePreviewEvents>;
    readonly onDiscoveredLocalServers: RpcStreamMethod<
      typeof WS_METHODS.subscribeDiscoveredLocalServers
    >;
    readonly automation: {
      readonly connect: RpcInputStreamMethod<typeof WS_METHODS.previewAutomationConnect>;
      readonly respond: RpcUnaryMethod<typeof WS_METHODS.previewAutomationRespond>;
      readonly focusHost: RpcUnaryMethod<typeof WS_METHODS.previewAutomationFocusHost>;
    };
  };
  readonly device: {
    readonly configure: RpcUnaryMethod<typeof WS_METHODS.deviceConfigure>;
    readonly list: RpcUnaryMethod<typeof WS_METHODS.deviceList>;
    readonly testHost: RpcUnaryMethod<typeof WS_METHODS.deviceTestHost>;
    readonly open: RpcUnaryMethod<typeof WS_METHODS.deviceOpen>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.deviceClose>;
    readonly shutdown: RpcUnaryMethod<typeof WS_METHODS.deviceShutdown>;
    readonly detail: RpcUnaryMethod<typeof WS_METHODS.deviceDetail>;
    readonly action: RpcUnaryMethod<typeof WS_METHODS.deviceAction>;
    readonly onState: RpcStreamMethod<typeof WS_METHODS.subscribeDeviceState>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<LocalApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
    readonly revealInFileManager: RpcUnaryMethod<typeof WS_METHODS.shellRevealInFileManager>;
  };
  readonly git: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.gitPull>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.gitRefreshStatus>;
    readonly onStatus: (
      input: RpcInput<typeof WS_METHODS.subscribeGitStatus>,
      listener: (status: GitStatusResult) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly listBranches: RpcUnaryMethod<typeof WS_METHODS.gitListBranches>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.gitCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.gitRemoveWorktree>;
    readonly createBranch: RpcUnaryMethod<typeof WS_METHODS.gitCreateBranch>;
    readonly checkout: RpcUnaryMethod<typeof WS_METHODS.gitCheckout>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.gitInit>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly listOpenPullRequests: RpcUnaryMethod<typeof WS_METHODS.gitListOpenPullRequests>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
    readonly resolveReviewChangesContext: RpcUnaryMethod<
      typeof WS_METHODS.gitResolveReviewChangesContext
    >;
    readonly prewarmReviewChangesContext: RpcUnaryMethod<
      typeof WS_METHODS.gitPrewarmReviewChangesContext
    >;
  };
  readonly pullRequests: {
    readonly list: RpcUnaryMethod<typeof WS_METHODS.pullRequestsList>;
    readonly listStats: RpcUnaryMethod<typeof WS_METHODS.pullRequestsListStats>;
    readonly detail: RpcUnaryMethod<typeof WS_METHODS.pullRequestsDetail>;
    readonly activity: RpcUnaryMethod<typeof WS_METHODS.pullRequestsActivity>;
    readonly runAction: RpcUnaryMethod<typeof WS_METHODS.pullRequestsRunAction>;
    readonly comment: RpcUnaryMethod<typeof WS_METHODS.pullRequestsComment>;
    readonly submitReview: RpcUnaryMethod<typeof WS_METHODS.pullRequestsSubmitReview>;
    readonly replyToThread: RpcUnaryMethod<typeof WS_METHODS.pullRequestsReplyToThread>;
    readonly setThreadResolution: RpcUnaryMethod<typeof WS_METHODS.pullRequestsSetThreadResolution>;
    readonly invalidate: RpcUnaryMethod<typeof WS_METHODS.pullRequestsInvalidate>;
    readonly reviewerCandidates: RpcUnaryMethod<typeof WS_METHODS.pullRequestsReviewerCandidates>;
    readonly requestReviewers: RpcUnaryMethod<typeof WS_METHODS.pullRequestsRequestReviewers>;
    readonly usageReport: RpcUnaryMethod<typeof WS_METHODS.pullRequestsUsageReport>;
    readonly quotaRefresh: RpcUnaryMethod<typeof WS_METHODS.pullRequestsQuotaRefresh>;
  };
  readonly pullRequestMonitors: {
    readonly start: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsStart>;
    readonly stop: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsStop>;
    readonly status: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsStatus>;
    readonly list: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsList>;
    readonly context: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsContext>;
    readonly report: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsReport>;
    readonly transfer: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsTransfer>;
    readonly submitFindings: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsSubmitFindings>;
    readonly launchFallback: RpcUnaryMethod<typeof WS_METHODS.pullRequestMonitorsLaunchFallback>;
  };
  readonly collaborativeAcceptance: {
    readonly submitCandidate: RpcUnaryMethod<
      typeof WS_METHODS.collaborativeAcceptanceSubmitCandidate
    >;
    readonly requestReview: RpcUnaryMethod<typeof WS_METHODS.collaborativeAcceptanceRequestReview>;
    readonly status: RpcUnaryMethod<typeof WS_METHODS.collaborativeAcceptanceStatus>;
    readonly resolveForPullRequest: RpcUnaryMethod<
      typeof WS_METHODS.collaborativeAcceptanceResolveForPullRequest
    >;
    readonly submitAssessment: RpcUnaryMethod<
      typeof WS_METHODS.collaborativeAcceptanceSubmitAssessment
    >;
    readonly pause: RpcUnaryMethod<typeof WS_METHODS.collaborativeAcceptancePause>;
    readonly resume: RpcUnaryMethod<typeof WS_METHODS.collaborativeAcceptanceResume>;
  };
  readonly workflow: {
    readonly run: RpcUnaryMethod<typeof WS_METHODS.workflowRun>;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    /**
     * Refresh provider snapshots. Pass `{ instanceId }` to refresh a single
     * configured instance; pass no argument (or `{}`) to refresh all.
     */
    readonly refreshProviders: (
      input?: RpcInput<typeof WS_METHODS.serverRefreshProviders>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverRefreshProviders>>;
    readonly listProviderCommands: RpcUnaryMethod<typeof WS_METHODS.serverListProviderCommands>;
    readonly prewarmProviderSession: RpcUnaryMethod<typeof WS_METHODS.serverPrewarmProviderSession>;
    readonly sessionCommand: RpcUnaryMethod<typeof WS_METHODS.providerSessionCommand>;
    readonly listSkills: RpcUnaryNoArgMethod<typeof WS_METHODS.serverListSkills>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly replaceKeybindingRules: RpcUnaryMethod<typeof WS_METHODS.serverReplaceKeybindingRules>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly exportActiveChats: RpcUnaryNoArgMethod<typeof WS_METHODS.serverExportActiveChats>;
    readonly importChatArchive: RpcUnaryMethod<typeof WS_METHODS.serverImportChatArchive>;
    readonly exportThreadMarkdown: RpcUnaryMethod<typeof WS_METHODS.serverExportThreadMarkdown>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getShellSnapshot: RpcUnaryNoArgMethod<
      typeof ORCHESTRATION_WS_METHODS.getShellSnapshot
    >;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getThreadActivities: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.getThreadActivities
    >;
    readonly getDelegationAuditPage: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.getDelegationAuditPage
    >;
    readonly beginDelegationAudit: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.beginDelegationAudit
    >;
    readonly appendDelegationAuditEvent: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.appendDelegationAuditEvent
    >;
    readonly getActivityEvidence: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.getActivityEvidence
    >;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getTurnDiffState: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiffState>;
    readonly getFullThreadDiffState: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.getFullThreadDiffState
    >;
    readonly getArchivedShellSnapshot: RpcUnaryNoArgMethod<
      typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot
    >;
    readonly searchTranscript: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.searchTranscript>;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
  };
}

export function createWsRpcClient(transport: WsTransport): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      resetWsReconnectBackoff();
      await transport.reconnect();
    },
    sidebar: {
      getState: () => transport.request((client) => client[WS_METHODS.sidebarGetState]({})),
      updateState: (input) =>
        transport.request((client) => client[WS_METHODS.sidebarUpdateState](input)),
      onState: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeSidebarState]({}),
          listener,
          options,
        ),
    },
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
          listener,
          options,
        ),
    },
    projects: {
      listEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsListEntries](input)),
      readFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsReadFile](input)),
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    assets: {
      createUrl: (input) =>
        transport.request((client) => client[WS_METHODS.assetsCreateUrl](input)),
    },
    preview: {
      open: (input) => transport.request((client) => client[WS_METHODS.previewOpen](input)),
      navigate: (input) => transport.request((client) => client[WS_METHODS.previewNavigate](input)),
      reportStatus: (input) =>
        transport.request((client) => client[WS_METHODS.previewReportStatus](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.previewResize](input)),
      refresh: (input) => transport.request((client) => client[WS_METHODS.previewRefresh](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.previewClose](input)),
      list: (input) => transport.request((client) => client[WS_METHODS.previewList](input)),
      onEvent: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribePreviewEvents]({}),
          listener,
          options,
        ),
      onDiscoveredLocalServers: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeDiscoveredLocalServers]({}),
          listener,
          options,
        ),
      automation: {
        connect: (input, listener, options) =>
          transport.subscribe(
            (client) => client[WS_METHODS.previewAutomationConnect](input),
            listener,
            options,
          ),
        respond: (input) =>
          transport.request((client) => client[WS_METHODS.previewAutomationRespond](input)),
        focusHost: (input) =>
          transport.request((client) => client[WS_METHODS.previewAutomationFocusHost](input)),
      },
    },
    device: {
      configure: (input) =>
        transport.request((client) => client[WS_METHODS.deviceConfigure](input)),
      list: (input) => transport.request((client) => client[WS_METHODS.deviceList](input)),
      testHost: (input) => transport.request((client) => client[WS_METHODS.deviceTestHost](input)),
      open: (input) => transport.request((client) => client[WS_METHODS.deviceOpen](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.deviceClose](input)),
      shutdown: (input) => transport.request((client) => client[WS_METHODS.deviceShutdown](input)),
      detail: (input) => transport.request((client) => client[WS_METHODS.deviceDetail](input)),
      action: (input) => transport.request((client) => client[WS_METHODS.deviceAction](input)),
      onState: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeDeviceState]({}),
          listener,
          options,
        ),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
      revealInFileManager: (input) =>
        transport.request((client) => client[WS_METHODS.shellRevealInFileManager](input)),
    },
    git: {
      pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.gitRefreshStatus](input)),
      onStatus: (input, listener, options) => {
        let current: GitStatusResult | null = null;
        return transport.subscribe(
          (client) => client[WS_METHODS.subscribeGitStatus](input),
          (event: GitStatusStreamEvent) => {
            current = applyGitStatusStreamEvent(current, event);
            listener(current);
          },
          options,
        );
      },
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      listOpenPullRequests: (input) =>
        transport.request((client) => client[WS_METHODS.gitListOpenPullRequests](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
      resolveReviewChangesContext: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolveReviewChangesContext](input)),
      prewarmReviewChangesContext: (input) =>
        transport.request((client) => client[WS_METHODS.gitPrewarmReviewChangesContext](input)),
    },
    pullRequests: {
      list: (input) => transport.request((client) => client[WS_METHODS.pullRequestsList](input)),
      listStats: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsListStats](input)),
      detail: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsDetail](input)),
      activity: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsActivity](input)),
      runAction: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsRunAction](input)),
      comment: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsComment](input)),
      submitReview: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsSubmitReview](input)),
      replyToThread: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsReplyToThread](input)),
      setThreadResolution: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsSetThreadResolution](input)),
      invalidate: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsInvalidate](input)),
      reviewerCandidates: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsReviewerCandidates](input)),
      requestReviewers: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsRequestReviewers](input)),
      usageReport: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsUsageReport](input)),
      quotaRefresh: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestsQuotaRefresh](input)),
    },
    pullRequestMonitors: {
      start: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsStart](input)),
      stop: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsStop](input)),
      status: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsStatus](input)),
      list: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsList](input)),
      context: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsContext](input)),
      report: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsReport](input)),
      transfer: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsTransfer](input)),
      submitFindings: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsSubmitFindings](input)),
      launchFallback: (input) =>
        transport.request((client) => client[WS_METHODS.pullRequestMonitorsLaunchFallback](input)),
    },
    collaborativeAcceptance: {
      submitCandidate: (input: {
        readonly threadId: ThreadId;
        readonly submission: CollaborativeAcceptanceCandidateSubmission;
      }) =>
        transport.request((client) =>
          client[WS_METHODS.collaborativeAcceptanceSubmitCandidate](input),
        ),
      requestReview: (input) =>
        transport.request((client) =>
          client[WS_METHODS.collaborativeAcceptanceRequestReview](input),
        ),
      status: (input) =>
        transport.request((client) => client[WS_METHODS.collaborativeAcceptanceStatus](input)),
      resolveForPullRequest: (input) =>
        transport.request((client) =>
          client[WS_METHODS.collaborativeAcceptanceResolveForPullRequest](input),
        ),
      submitAssessment: (input: {
        readonly threadId: ThreadId;
        readonly submission: CollaborativeAcceptanceAssessmentSubmission;
      }) =>
        transport.request((client) =>
          client[WS_METHODS.collaborativeAcceptanceSubmitAssessment](input),
        ),
      pause: (input: {
        readonly threadId: ThreadId;
        readonly caseId: CollaborativeAcceptanceCaseId;
        readonly reason: CollaborativeAcceptancePauseReason;
      }) => transport.request((client) => client[WS_METHODS.collaborativeAcceptancePause](input)),
      resume: (input) =>
        transport.request((client) => client[WS_METHODS.collaborativeAcceptanceResume](input)),
    },
    workflow: {
      run: (input) => transport.request((client) => client[WS_METHODS.workflowRun](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: (input) =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders](input ?? {})),
      listProviderCommands: (input) =>
        transport.request((client) => client[WS_METHODS.serverListProviderCommands](input)),
      prewarmProviderSession: (input) =>
        transport.request((client) => client[WS_METHODS.serverPrewarmProviderSession](input)),
      sessionCommand: (input) =>
        transport.request((client) => client[WS_METHODS.providerSessionCommand](input)),
      listSkills: () => transport.request((client) => client[WS_METHODS.serverListSkills]({})),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      replaceKeybindingRules: (input) =>
        transport.request((client) => client[WS_METHODS.serverReplaceKeybindingRules](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      exportActiveChats: () =>
        transport.request((client) => client[WS_METHODS.serverExportActiveChats]({})),
      importChatArchive: (input) =>
        transport.request((client) => client[WS_METHODS.serverImportChatArchive](input)),
      exportThreadMarkdown: (input) =>
        transport.request((client) => client[WS_METHODS.serverExportThreadMarkdown](input)),
      subscribeConfig: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerConfig]({}),
          listener,
          options,
        ),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
          listener,
          options,
        ),
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeAuthAccess]({}),
          listener,
          options,
        ),
    },
    orchestration: {
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getShellSnapshot: () =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getShellSnapshot]({})),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getThreadActivities: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getThreadActivities](input)),
      getDelegationAuditPage: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getDelegationAuditPage](input),
        ),
      beginDelegationAudit: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.beginDelegationAudit](input)),
      appendDelegationAuditEvent: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.appendDelegationAuditEvent](input),
        ),
      getActivityEvidence: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getActivityEvidence](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getTurnDiffState: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiffState](input)),
      getFullThreadDiffState: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiffState](input),
        ),
      getArchivedShellSnapshot: () =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({}),
        ),
      searchTranscript: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.searchTranscript](input)),
      subscribeShell: (listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
          listener,
          options,
        ),
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          options,
        ),
    },
  };
}
