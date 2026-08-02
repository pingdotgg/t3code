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
    readonly listSkills: RpcUnaryNoArgMethod<typeof WS_METHODS.serverListSkills>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
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
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getTurnDiffState: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiffState>;
    readonly getFullThreadDiffState: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.getFullThreadDiffState
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
      listSkills: () => transport.request((client) => client[WS_METHODS.serverListSkills]({})),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
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
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getTurnDiffState: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiffState](input)),
      getFullThreadDiffState: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiffState](input),
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
