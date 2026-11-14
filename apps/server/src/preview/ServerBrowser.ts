// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
// Screencasts ignore emulated device scale; real 2x keeps captures sharp.
// --disable-gpu uses cheaper software compositing while preserving SwiftShader WebGL.
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  FILL_PREVIEW_VIEWPORT,
  findBrowserProfile,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
  type PreviewReportProfilesInput,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewViewportSetting as PreviewViewportSettingSchema,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationDialogInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
  PreviewClearProfileError,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewAppearancePreference,
} from "@t3tools/contracts";
import { AgentScope, agentScopeLauncherScript } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Frame,
  Page,
} from "playwright-core";

import { PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";
import { installPdfDocumentNavigation, isPdfAssetUrl } from "./PdfDocumentNavigation.ts";
import type { EncoderWindow, Recording, ServerDownload, ServerTab, ViewerState } from "./ServerBrowser-part2.ts";
import { ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS, AGENT_TAB_IDLE_MS, AGENT_TAB_LIMIT, CLIPBOARD_SCRIPT, CLIPBOARD_WORLD, DOWNLOAD_LIMIT, DOWNLOAD_MAX_BYTES, IDLE_SWEEP_INTERVAL, READ_OPERATIONS, SERVER_TAB_LIMIT, asRecord, editingCommand, fixedViewportSize, modifiersOf, num, pushBounded, tabKey, viewportSettingsEqual } from "./ServerBrowser-part2.ts";
import type { ProfileReporter, ServerBrowserViewer, ServerBrowserViewerOutput } from "./ServerBrowser-part3.ts";
import { ACTION_TIMELINE_LIMIT, AGENT_CURSOR_CLICK_LEAD_MS, AGENT_CURSOR_MOVE_MS, DESKTOP_ATTACH_TIMEOUT, DESKTOP_VIEWPORT_READ_TIMEOUT, EDITABLE_AT_POINT_SCRIPT, HOST_RECONNECT_DELAY, NAVIGATION_TIMEOUT_MS, RECORDING_SCREENCAST, RENDER_SCALE, SCREENCAST_ACK_PACE_MS, SCREENCAST_MOTION_FRAMES, SCREENCAST_MOTION_QUALITY, SCREENCAST_MOTION_WINDOW_MS, SCREENCAST_SETTLE_MS, SERVER_HOST_CLIENT_ID, ServerBrowserLaunchError, ServerBrowserTabNotFoundError, UNATTACHED_FILL_VIEWPORT, VIEWER_NAVIGATION_OPTIONS, VIEWER_OUTPUT_LIMIT, decodeViewportSetting, isHostSetupError, isTabNotFound, sleepUntil } from "./ServerBrowser-part3.ts";

export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    readonly attachViewer: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
      readonly canOperate: boolean;
    }) => Effect.Effect<
      ServerBrowserViewer,
      ServerBrowserTabNotFoundError | ServerBrowserLaunchError,
      Scope.Scope
    >;

    readonly answerFileChooser: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly chooserId: string;
      readonly files: ReadonlyArray<{
        readonly name: string;
        readonly mimeType: string;
        readonly buffer: Buffer;
      }>;
    }) => Effect.Effect<boolean>;
    readonly openDownload: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly downloadId: string;
    }) => Effect.Effect<Option.Option<{ readonly path: string; readonly fileName: string }>>;

    readonly clearProfile: (profileId: string) => Effect.Effect<void, PreviewClearProfileError>;

    readonly profileReporter: Effect.Effect<ProfileReporter, never, Scope.Scope>;
  }
>()("t3/preview/ServerBrowser") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
  const manager = yield* PreviewManager.PreviewManager;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const agentTurns = yield* (yield* PreviewAgentActivity.PreviewAgentActivity).changes;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const launchServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  // sudo resets the environment, so the command has to name this server's home.
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND, [
    "--base-dir",
    config.baseDir,
  ]);
  const agentScope = yield* AgentScope;
  const launchersDir = NodePath.join(config.stateDir, "server-browser", "launchers");

  const tabs = new Map<string, ServerTab>();
  const pendingTabs = new Map<
    string,
    { readonly agentId: string | null; promise?: Promise<ServerTab> }
  >();

  const closedPendingTabs = new Set<string>();
  const adoptedPages = new Map<string, { readonly page: Page; readonly openerTabId: string }>();
  const closedSessions = new Set<string>();
  let hostConnectionId: string | null = null;

  const contexts = new ServerBrowserContexts({
    profilesDir: NodePath.join(config.stateDir, "server-browser", "profiles"),
    executable: () => runPromise(previewBrowser.executable),
    // An agent scope keeps Chrome out of the server's memory protection and OOM score.
    launcher: async (executable) => {
      const launch = await runPromise(
        agentScope.wrap({ command: executable, args: [], name: "preview-browser" }),
      );
      if (launch.command === executable) return undefined;
      await NodeFSP.mkdir(launchersDir, { recursive: true });
      const launcher = NodePath.join(launchersDir, NodeCrypto.randomUUID());
      await NodeFSP.writeFile(launcher, agentScopeLauncherScript(launch), { mode: 0o700 });
      return { path: launcher, release: () => NodeFSP.rm(launcher, { force: true }) };
    },
    // Playwright's launch error drops Chrome's own output; its sandbox note survives.
    diagnose: (executable, cause) =>
      Effect.runPromiseWith(launchServices)(
        PreviewBrowserHost.diagnoseLaunchFailure({
          executable,
          setupCommand,
          output: /sandboxing failed/i.test(String(cause))
            ? PreviewBrowserHost.NO_SANDBOX_SIGNATURE
            : "",
        }),
      ),
    onContextClose: (context) => {
      for (const tab of tabs.values()) {
        if (tab.page.context() === context) dropTab(tab, true);
      }
    },
  });

  const dialogStatus = (tab: ServerTab) =>
    tab.dialog
      ? {
          type: tab.dialog.type(),
          message: tab.dialog.message().slice(0, 4000),
          defaultValue: tab.dialog.defaultValue().slice(0, 4000),
        }
      : null;

  const updateFileChooserInterception = (tab: ServerTab) => {
    // Only agents and streamed controllers can answer intercepted uploads; native desktop views use the OS picker.
    const intercept = !tab.desktop || tab.agentOperating || tab.control.controller !== null;
    if (intercept === tab.fileChooserIntercepted) return;
    tab.fileChooserIntercepted = intercept;
    if (intercept) tab.page.on("filechooser", tab.onFileChooser);
    else tab.page.off("filechooser", tab.onFileChooser);
  };

  const broadcastControl = (tab: ServerTab) => {
    updateFileChooserInterception(tab);
    for (const viewer of tab.viewers)
      viewer.push({
        _tag: "control",
        canOperate: viewer.canOperate,
        controller:
          tab.control.controller === viewer.id
            ? "you"
            : tab.control.controller !== null
              ? "another-viewer"
              : tab.control.agentId !== null
                ? "agent"
                : "unclaimed",
        generation: tab.control.generation,
        dialog: dialogStatus(tab),
      });
  };

  const resolveDialog = async (tab: ServerTab, input: PreviewAutomationDialogInput) => {
    const dialog = tab.dialog;
    if (!dialog) throw new Error("No dialog is pending.");
    if (input.accept) await dialog.accept(input.promptText);
    else await dialog.dismiss();
    if (tab.dialog === dialog) tab.dialog = null;
    ServerBrowserPage.invalidateRefs(tab.page);
    broadcastControl(tab);
  };

  const report = (tab: ServerTab, navStatus: PreviewNavStatus) => {
    void tab.cdp
      .send("Page.getNavigationHistory")
      .catch(() => null)
      .then((history) => {
        const index = history?.currentIndex ?? 0;
        const count = history?.entries.length ?? 0;
        runFork(
          manager
            .reportStatus({
              threadId: tab.threadId,
              tabId: tab.tabId,
              serverControlled: true,
              navStatus,
              canGoBack: index > 0,
              canGoForward: index < count - 1,
            })
            .pipe(Effect.ignore),
        );
      });
  };

  const reportLoaded = async (tab: ServerTab) => {
    const url = tab.page.url();
    // Chromium's error page loads after `requestfailed` and must not clear LoadFailed.
    if (url === "about:blank" || url.startsWith("chrome-error://")) return;
    // A navigation that starts and fails during the title read leaves the URL unchanged.
    const generation = tab.navigationGeneration;
    const title = (await tab.page.title().catch(() => "")).slice(0, 512);
    if (tab.navigationGeneration !== generation || tab.loading || tab.page.url() !== url) return;
    report(tab, {
      _tag: "Success",
      url: ServerBrowserPage.withoutDataPayload(url).slice(0, 2048),
      title,
    });
  };

  const reportLiveTabs = () => {
    const connectionId = hostConnectionId;
    if (connectionId === null) return;
    runFork(
      environment.getEnvironmentId.pipe(
        Effect.flatMap((environmentId) =>
          broker.focusHost({
            clientId: SERVER_HOST_CLIENT_ID,
            environmentId,
            connectionId,
            focused: true,
            liveTabs: [...tabs.values()].map((tab) => ({
              threadId: tab.threadId,
              tabId: tab.tabId,
              visible: tab.viewers.size > 0,
            })),
          }),
        ),
      ),
    );
  };

  const downloadsRoot = NodePath.join(config.stateDir, "server-browser", "downloads");
  // Saved downloads are indexed in memory, so an earlier run's files can never be opened again.
  yield* Effect.tryPromise(() => NodeFSP.rm(downloadsRoot, { recursive: true, force: true })).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("server preview could not clear earlier downloads", { cause }),
    ),
  );

  const files = createServerBrowserFiles({
    tabs,
    tabKey,
    runFork,
    report,
    reportLoaded,
    stateDir: config.stateDir,
  });
  const {
    downloadDir,
    clearAbortedNavigation,
    settleAbortedNavigation,
    saveDownload,
    offerFileChooser,
    isFileChooserCurrent,
    closeFileChooser,
    pushFileChooser,
    uploadFiles,
    answerFileChooser,
    openDownload,
  } = files;

  const pages = createServerBrowserPages({ runFork });
  const { prepareContext, recordCopies, recordFrameCopies, takeCopiedText } = pages;

  const tabsRuntime = createServerBrowserTabs({
    runPromise,
    runFork,
    manager,
    desktopChannel,
    contexts,
    host,
    adoptedPages,
    pendingTabs,
    closedPendingTabs,
    closedSessions,
    tabs,
    tabKey,
    report,
    reportLoaded,
    reportLiveTabs,
    broadcastControl,
    updateFileChooserInterception,
    downloadDir,
    clearAbortedNavigation,
    settleAbortedNavigation,
    saveDownload,
    offerFileChooser,
    isFileChooserCurrent,
    closeFileChooser,
    prepareContext,
    recordCopies,
    recordFrameCopies,
  });
  const {
    dropTab,
    ensureTab,
    findTab,
    openTab,
    closeIdleAgentTabs,
    latestThreadTab,
    tabOwner,
    layoutSize,
    applySetting,
    applyRendering,
    broadcastViewport,
    adoptPopup,
  } = tabsRuntime;

  const sessionParts = createServerBrowserSession({ tabs, tabKey, layoutSize, tabOwner, dialogStatus });
  const {
    profileReporter,
    resolveOpenProfile,
    statusWithTitle,
    resolveNavigationUrl,
    navigate,
    recordingFrameRate,
  } = sessionParts;

  const { withCaptureLock, startRecording, stopRecording, withScreencastsPaused } =
    createServerBrowserRecording({
      contexts,
      attachmentsDir: config.attachmentsDir,
      frameRate: () => (recordingFrameRate() === 60 ? 60 : 30),
    });

  const operations = createServerBrowserOperations({
    tabs,
    tabKey,
    runPromise,
    runFork,
    manager,
    desktopChannel,
    READ_OPERATIONS,
    findTab,
    latestThreadTab,
    closeIdleAgentTabs,
    openTab,
    dropTab,
    applySetting,
    applyRendering,
    statusWithTitle,
    resolveOpenProfile,
    resolveNavigationUrl,
    navigate,
    withScreencastsPaused,
    startRecording,
    stopRecording,
    uploadFiles,
    resolveDialog,
    updateFileChooserInterception,
  });
  const { runOperation, markUsed } = operations;

  const { attachViewer } = createServerBrowserViewer({
    tabs,
    runFork,
    runPromise,
    manager,
    findTab,
    reportLiveTabs,
    broadcastControl,
    pushFileChooser,
    withCaptureLock,
    resolveDialog,
    applySetting,
    broadcastViewport,
    takeCopiedText,
  });


  const handleRequest = (connectionId: string, request: PreviewAutomationRequest) =>
    Effect.tryPromise({
      try: () =>
        runOperation(request, performance.now() + request.timeoutMs).finally(() =>
          markUsed(request),
        ),
      catch: ServerBrowserPage.toOperationError,
    }).pipe(
      Effect.match({
        onSuccess: (result) => ({ ok: true as const, result }),
        onFailure: (error) => ({
          ok: false as const,
          error: {
            _tag: error.tag,
            message: error.message,
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          },
        }),
      }),
      Effect.flatMap((outcome) =>
        broker.respond({
          clientId: SERVER_HOST_CLIENT_ID,
          connectionId,
          requestId: request.requestId,
          ...outcome,
        }),
      ),
      Effect.ignore,
    );

  const mirrorManagerEvent = (event: PreviewEvent) =>
    Effect.promise(async () => {
      if (event.type === "opened" && event.snapshot.runtime === "server") {
        const key = tabKey(event.snapshot.threadId, event.snapshot.tabId);
        if (event.snapshot.automationOwner === undefined || pendingTabs.has(key) || tabs.has(key))
          await ensureTab(event.snapshot).catch(constVoid);
        return;
      }
      const key = tabKey(event.threadId, event.tabId);
      const tab = tabs.get(key);
      if (event.type === "closed" && !tab && pendingTabs.has(key)) closedPendingTabs.add(key);
      if (!tab) return;
      if (event.type === "closed") {
        closedSessions.add(key);
        dropTab(tab, false);
        closedSessions.delete(key);
        return;
      }
      if (event.type === "resized") {
        await tab.control
          .system(async () => {
            if (
              !viewportSettingsEqual(event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT, tab.setting)
            ) {
              await applySetting(tab, event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT);
            }
            await applyRendering(tab, event.snapshot);
            const request = event.request;
            if (request?.clear === "cookies") await tab.cdp.send("Network.clearBrowserCookies");
            if (request?.clear === "cache") await tab.cdp.send("Network.clearBrowserCache");
            if (request?.hardReload) await tab.cdp.send("Page.reload", { ignoreCache: true });
          })
          .catch((cause: unknown) =>
            runFork(Effect.logWarning("server preview could not apply a tab setting", { cause })),
          );
      }
    });


  yield* manager.events.pipe(Stream.runForEach(mirrorManagerEvent), Effect.forkScoped);
  if (
    !PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment) &&
    (yield* PreviewBrowserHost.sandboxBlocked)
  ) {
    yield* Effect.logWarning(
      `This host blocks the sandbox T3's browser runs in, so browser tabs and HTML previews will not start. Run \`${setupCommand}\` once to allow it.`,
    );
  }

  yield* desktopChannel.detached.pipe(
    Stream.runForEach((key) =>
      Effect.sync(() => {
        const tab = tabs.get(tabKey(key.threadId, key.tabId));
        if (tab?.desktop) dropTab(tab, false);
      }),
    ),
    Effect.forkScoped,
  );
  // The desktop keeps the tabs an agent uses focused until its turn ends, not just per command.
  yield* Stream.fromSubscription(agentTurns).pipe(
    Stream.runForEach((change) => desktopChannel.turn(change.threadId, change.active)),
    Effect.forkScoped,
  );
  // Reconnect returned pages immediately so all clients keep receiving URL and title changes.
  yield* desktopChannel.attached.pipe(
    Stream.runForEach((key) =>
      Effect.gen(function* () {
        if (tabs.has(tabKey(key.threadId, key.tabId))) return;
        const { sessions } = yield* manager.list({ threadId: ThreadId.make(key.threadId) });
        const snapshot = sessions.find(
          (session) => session.tabId === key.tabId && session.runtime === "server",
        );
        if (snapshot) yield* Effect.promise(() => ensureTab(snapshot).catch(constVoid));
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  yield* Effect.sync(closeIdleAgentTabs).pipe(
    Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)),
    Effect.forkScoped,
  );
  const environmentId = yield* environment.getEnvironmentId;
  const hostSession = broker
    .connect(
      {
        clientId: SERVER_HOST_CLIENT_ID,
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
      },
      { preferred: true },
    )
    .pipe(
      Effect.flatMap((events) =>
        events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "connected") {
              hostConnectionId = event.connectionId;
              return Effect.sync(reportLiveTabs);
            }
            return handleRequest(event.connectionId, event.request).pipe(
              Effect.forkScoped,
              Effect.asVoid,
            );
          }),
        ),
      ),
    );
  // The broker disconnects timed-out hosts, including slow first installs. Reconnect.
  yield* hostSession.pipe(
    Effect.exit,
    Effect.andThen(Effect.sleep(HOST_RECONNECT_DELAY)),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await contexts.close();
    }),
  );

  const clearProfile = (profileId: string) =>
    Effect.tryPromise({
      try: () => contexts.clearProfile(profileId),
      catch: (cause) => new PreviewClearProfileError({ profileId, cause }),
    });

  return ServerBrowser.of({
    attachViewer,
    clearProfile,
    profileReporter,
    openDownload,
    answerFileChooser,
  });
});

export const layer = Layer.effect(ServerBrowser, make);
import {
  createServerBrowserFiles,
} from "./ServerBrowser-files.ts";
import { createServerBrowserOperations } from "./ServerBrowser-operations.ts";
import { createServerBrowserPages } from "./ServerBrowser-pages.ts";
import { createServerBrowserRecording } from "./ServerBrowser-recording.ts";
import { createServerBrowserSession } from "./ServerBrowser-session.ts";
import { createServerBrowserTabs } from "./ServerBrowser-tabs.ts";
import { createServerBrowserViewer } from "./ServerBrowser-viewer.ts";
export * from "./ServerBrowser-part3.ts";
