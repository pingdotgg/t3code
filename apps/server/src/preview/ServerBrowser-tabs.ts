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
import type { ServerBrowser } from "./ServerBrowser.ts";

export interface ServerBrowserTabsDeps {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, never>) => unknown;
  readonly manager: PreviewManager.PreviewManager["Service"];
  readonly desktopChannel: DesktopBrowserChannel.DesktopBrowserChannel["Service"];
  readonly contexts: ServerBrowserContexts;
  readonly host: Parameters<typeof presentAsChrome>[1];
  readonly adoptedPages: Map<string, { readonly page: Page; readonly openerTabId: string }>;
  readonly pendingTabs: Map<
    string,
    { readonly agentId: string | null; promise?: Promise<ServerTab> }
  >;
  readonly closedPendingTabs: Set<string>;
  readonly closedSessions: Set<string>;
  readonly tabs: Map<string, ServerTab>;
  readonly tabKey: (threadId: string, tabId: string) => string;
  readonly report: (tab: ServerTab, navStatus: PreviewNavStatus) => void;
  readonly reportLoaded: (tab: ServerTab) => Promise<void>;
  readonly reportLiveTabs: () => void;
  readonly broadcastControl: (tab: ServerTab) => void;
  readonly updateFileChooserInterception: (tab: ServerTab) => void;
  readonly downloadDir: (tab: ServerTab) => string;
  readonly clearAbortedNavigation: (tab: ServerTab) => void;
  readonly settleAbortedNavigation: (
    tab: ServerTab,
    generation: number,
    url: string,
    offered: { readonly id: string; readonly fileName: string } | undefined,
  ) => void;
  readonly saveDownload: (tab: ServerTab, download: Download) => Promise<void>;
  readonly offerFileChooser: (tab: ServerTab, chooser: FileChooser) => Promise<void>;
  readonly isFileChooserCurrent: (chooser: FileChooser) => Promise<boolean>;
  readonly closeFileChooser: (tab: ServerTab) => void;
  readonly prepareContext: (context: BrowserContext) => Promise<void>;
  readonly recordCopies: (cdp: CDPSession) => Promise<void>;
  readonly recordFrameCopies: (tab: ServerTab, frame: Frame) => Promise<void>;
}

export const createServerBrowserTabs = (deps: ServerBrowserTabsDeps) => {
  const { runPromise, runFork, manager, desktopChannel, contexts, host, adoptedPages, pendingTabs, closedPendingTabs, closedSessions, tabs, tabKey,
    report, reportLoaded, reportLiveTabs, broadcastControl, updateFileChooserInterception,
    downloadDir, clearAbortedNavigation, settleAbortedNavigation, saveDownload,
    offerFileChooser, isFileChooserCurrent, closeFileChooser, prepareContext, recordCopies, recordFrameCopies } = deps;

  // Desktop pages have no Playwright viewport; an isolated world keeps page script
  // from overriding the CSS size, and failed reads preserve the last usable size.
  const readDesktopViewport = async (tab: ServerTab) => {
    const readSize = async () => {
      const { frameTree } = await tab.cdp.send("Page.getFrameTree");
      const { executionContextId } = await tab.cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "t3-preview-viewport",
      });
      const { result } = await tab.cdp.send("Runtime.evaluate", {
        expression: "({ width: innerWidth, height: innerHeight })",
        contextId: executionContextId,
        returnByValue: true,
      });
      return asRecord(result.value);
    };
    const size = await runPromise(
      // A navigation can destroy the isolated world mid-read.
      Effect.promise(() => readSize().catch(() => null)).pipe(
        Effect.timeoutOption(DESKTOP_VIEWPORT_READ_TIMEOUT),
        Effect.map(Option.getOrNull),
      ),
    );
    const width = size?.width;
    const height = size?.height;
    if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0)
      tab.desktopViewport = { width, height };
    return tab.desktopViewport;
  };

  // Reads run one at a time, and callers that arrive during a read share the next one.
  const measureDesktopViewport = (tab: ServerTab) =>
    (tab.desktopViewportNext ??= tab.desktopViewportRead.then(() => {
      tab.desktopViewportNext = null;
      return (tab.desktopViewportRead = readDesktopViewport(tab));
    }));

  const layoutSize = async (tab: ServerTab) => {
    // A dialog blocks page script; its close measures again.
    if (tab.desktop) return tab.dialog ? tab.desktopViewport : measureDesktopViewport(tab);
    const size = tab.page.viewportSize();
    if (!size) return size;
    return {
      width: Math.max(1, Math.round(size.width / tab.zoomFactor)),
      height: Math.max(1, Math.round(size.height / tab.zoomFactor)),
    };
  };

  const applyZoom = async (tab: ServerTab) => {
    if (tab.desktop) return;
    const size = tab.page.viewportSize();
    if (!size) return;
    if (tab.zoomFactor === 1) {
      await tab.page.setViewportSize(size);
      return;
    }
    const layout = (await layoutSize(tab))!;
    await tab.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: layout.width,
      height: layout.height,
      deviceScaleFactor: RENDER_SCALE * tab.zoomFactor,
      mobile: false,
    });
  };

  const broadcastViewport = async (tab: ServerTab) => {
    const size = await layoutSize(tab);
    if (!size || tab.closing) return;
    for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
  };

  const applySetting = async (tab: ServerTab, setting: PreviewViewportSetting) => {
    tab.setting = setting;

    if (tab.desktop) return;
    const size =
      fixedViewportSize(setting) ??
      [...tab.viewers]
        .map((viewer) => viewer.requestedSize)
        .filter((requested) => requested !== null)
        .sort((left, right) => right.order - left.order)[0] ??
      UNATTACHED_FILL_VIEWPORT;
    await tab.page.setViewportSize({ width: size.width, height: size.height });
    await applyZoom(tab);
    await broadcastViewport(tab);
  };

  const applyRendering = async (tab: ServerTab, snapshot: PreviewSessionSnapshot) => {
    const colorScheme = snapshot.colorScheme ?? "system";
    if (colorScheme !== tab.colorScheme) {
      tab.colorScheme = colorScheme;
      await tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme });
    }
    const zoomFactor = snapshot.zoomFactor ?? 1;
    if (zoomFactor !== tab.zoomFactor && !tab.desktop) {
      tab.zoomFactor = zoomFactor;
      await applyZoom(tab);
      await broadcastViewport(tab);
    }
  };

  const sessionOpen = (tab: ServerTab) => !closedSessions.has(tabKey(tab.threadId, tab.tabId));

  const dropTab = (tab: ServerTab, closeSession: boolean) => {
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab) return;
    tabs.delete(key);
    tab.closing = true;
    clearAbortedNavigation(tab);
    // A desktop page outlives the connection unless its session closed with it.
    const end = tab.desktop && !closeSession && sessionOpen(tab) ? "reconnect" : "gone";
    for (const viewer of tab.viewers) viewer.push({ _tag: end });
    void tab.control.close().catch(constVoid);
    if (tab.desktop) void tab.desktop.close().catch(constVoid);
    else void tab.page.close().catch(constVoid);
    if (tab.isolatedContext) void tab.page.context().close().catch(constVoid);
    void tab.recording?.encoder.close().catch(constVoid);
    void NodeFSP.rm(downloadDir(tab), { recursive: true, force: true }).catch(constVoid);
    reportLiveTabs();
    if (closeSession) {
      runFork(manager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore));
    }
  };

  const desktopRenders = (snapshot: PreviewSessionSnapshot) =>
    desktopChannel.available && !snapshot.headless
      ? runPromise(
          desktopChannel.awaitAttached(
            { threadId: snapshot.threadId, tabId: snapshot.tabId },
            DESKTOP_ATTACH_TIMEOUT,
          ),
        )
      : Promise.resolve(false);

  const connectDesktop = async (snapshot: PreviewSessionSnapshot) => {
    const scope = await runPromise(Scope.make());
    try {
      const endpoint = await runPromise(
        desktopChannel
          .endpoint({ threadId: snapshot.threadId, tabId: snapshot.tabId })
          .pipe(Scope.provide(scope)),
      );
      const connected = await contexts.connectDesktopPage(endpoint);
      return {
        page: connected.page,
        close: async () => {
          await connected.browser.close().catch(constVoid);
          await runPromise(Scope.close(scope, Exit.void));
        },
      };
    } catch (cause) {
      await runPromise(Scope.close(scope, Exit.void));
      throw cause;
    }
  };

  const createTab = async (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const opened: Array<() => Promise<void>> = [];
    try {
      return await setUpTab(snapshot, opened);
    } catch (cause) {
      // An unpublished tab is in no list, so nothing else would ever close it.
      for (const close of opened.reverse()) await close().catch(constVoid);
      throw cause;
    }
  };

  const setUpTab = async (
    snapshot: PreviewSessionSnapshot,
    opened: Array<() => Promise<void>>,
  ): Promise<ServerTab> => {
    const adopted = adoptedPages.get(tabKey(snapshot.threadId, snapshot.tabId));
    adoptedPages.delete(tabKey(snapshot.threadId, snapshot.tabId));
    const desktop =
      adopted === undefined && (await desktopRenders(snapshot))
        ? await connectDesktop(snapshot)
        : null;
    if (desktop) opened.push(desktop.close);
    // Otherwise a desktop that attaches late shows its own page, and the agent drives another.
    if (!desktop && desktopChannel.available) {
      await runPromise(
        manager
          .markHeadless({ threadId: ThreadId.make(snapshot.threadId), tabId: snapshot.tabId })
          .pipe(Effect.ignore),
      );
    }
    const isolatedContext =
      adopted === undefined &&
      desktop === null &&
      ((snapshot.automationOwner !== undefined && snapshot.profileId === undefined) ||
        snapshot.profileId === INCOGNITO_BROWSER_PROFILE_ID);
    const context =
      adopted?.page.context() ??
      desktop?.page.context() ??
      (await contexts.contextFor(
        snapshot.profileId ?? "default",
        isolatedContext ? tabKey(snapshot.threadId, snapshot.tabId) : undefined,
      ));
    if (isolatedContext) opened.push(() => context.close());
    if (adopted?.page.isClosed()) throw new Error("The popup closed before it opened.");
    if (!desktop) await prepareContext(context);
    const page = adopted?.page ?? desktop?.page ?? (await context.newPage());
    if (!desktop) opened.push(() => page.close());
    const cdp = await context.newCDPSession(page);
    await installPdfDocumentNavigation(cdp);
    // The desktop's page is already a normal browser. A popup's first request
    // went out before it became a tab; everything after presents as Chrome.
    if (!desktop) await presentAsChrome(cdp, host);
    if (!desktop) await recordCopies(cdp);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const control = new SessionControl(snapshot.automationOwner ?? null, () =>
      ServerBrowserPage.invalidateRefs(page),
    );
    let pendingFileChooserOffer = Promise.resolve();
    const tab: ServerTab = {
      threadId: ThreadId.make(snapshot.threadId),
      tabId: snapshot.tabId,
      page,
      cdp,
      frameSessions: new Map(),
      createdAt: Date.now(),
      usedAt: Date.now(),
      viewers: new Set(),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      control,
      agentOperating: false,
      fileChooserIntercepted: false,
      onFileChooser: (chooser) => {
        pendingFileChooserOffer = pendingFileChooserOffer
          .then(() => offerFileChooser(tab, chooser))
          .catch(constVoid);
      },
      isolatedContext,
      desktop: desktop === null ? null : { close: desktop.close },
      profileId: snapshot.profileId,
      openerTabId: adopted?.openerTabId,
      downloads: [],
      fileChooser: null,
      dialog: null,
      setting: snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
      colorScheme: "system",
      zoomFactor: 1,
      desktopViewport: null,
      desktopViewportRead: Promise.resolve(null),
      desktopViewportNext: null,
      loading: false,
      closing: false,
      recording: null,
      recordingStart: null,
      initialNavigation: null,
      navigationGeneration: 0,
      abortedNavigation: null,
      captureLock: Promise.resolve(),
      capturing: 0,
    };
    if (!desktop) {
      await page.setViewportSize(fixedViewportSize(tab.setting) ?? UNATTACHED_FILL_VIEWPORT);
    }
    await applyRendering(tab, snapshot);
    if (desktop) {
      // The desktop resizes and zooms its webview itself; viewers map input with the new size.
      const remeasure = () => {
        if (tab.viewers.size > 0) return broadcastViewport(tab).catch(constVoid);
      };
      cdp.on("Page.frameResized", remeasure);
      // A read a navigation broke has a fresh page to measure.
      cdp.on("Page.loadEventFired", remeasure);
      // Closing a dialog resizes nothing, and the host can close it without us.
      cdp.on("Page.javascriptDialogClosed", () => {
        tab.dialog = null;
        return remeasure();
      });
      await cdp.send("Page.enable");
    }
    const isMainNavigation = (request: { isNavigationRequest(): boolean; frame(): unknown }) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const navigationGenerations = new WeakMap<object, number>();
    page.on("request", (request) => {
      if (!isMainNavigation(request)) return;
      navigationGenerations.set(request, ++tab.navigationGeneration);
      clearAbortedNavigation(tab);
      tab.loading = true;
      report(tab, {
        _tag: "Loading",
        url: ServerBrowserPage.withoutDataPayload(request.url()).slice(0, 2048),
        title: "",
      });
    });
    page.on("load", () => {
      tab.loading = false;
      void reportLoaded(tab);
    });
    page.on("framenavigated", (frame) => {
      const open = tab.fileChooser;
      if (open) {
        void isFileChooserCurrent(open.chooser).then((current) => {
          if (!current && tab.fileChooser?.chooser === open.chooser) closeFileChooser(tab);
        });
      }
      // Same-document navigations (SPA routes) fire no load event.
      if (frame === page.mainFrame() && !tab.loading) void reportLoaded(tab);
      if (!desktop) void recordFrameCopies(tab, frame);
    });
    // An adopted popup's frames may have loaded before the tab listened.
    if (adopted) for (const frame of page.frames()) void recordFrameCopies(tab, frame);
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      pushBounded(tab.networkEntries, {
        url: ServerBrowserPage.withoutDataPayload(request.url()),
        method: request.method(),
        status: null,
        failed: true,
        errorText,
        timestamp: new Date().toISOString(),
      });
      if (!isMainNavigation(request)) return;
      // Newer navigations own status; untracked initial popup requests yield to any tracked navigation.
      const generation = navigationGenerations.get(request) ?? 0;
      if (generation !== tab.navigationGeneration) return;
      // An aborted navigation is usually a download; its `download` event settles the status.
      if (errorText.includes("ERR_ABORTED")) {
        const url = request.url();
        const navigationGeneration = tab.navigationGeneration;
        clearAbortedNavigation(tab);
        tab.abortedNavigation = {
          url,
          generation: navigationGeneration,
          timer: setTimeout(() => {
            if (tab.abortedNavigation?.generation !== navigationGeneration) return;
            tab.abortedNavigation = null;
            if (!tab.closing) settleAbortedNavigation(tab, navigationGeneration, url, undefined);
          }, ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS),
        };
        return;
      }
      tab.loading = false;
      const { code, description } = ServerBrowserPage.parseNetError(errorText);
      report(tab, {
        _tag: "LoadFailed",
        url: ServerBrowserPage.withoutDataPayload(request.url()).slice(0, 2048),
        title: "",
        code,
        description,
      });
    });
    page.on("response", (response) => {
      pushBounded(tab.networkEntries, {
        url: ServerBrowserPage.withoutDataPayload(response.url()),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: new Date().toISOString(),
      });
    });
    page.on("console", (message) => {
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: ServerBrowserPage.consoleText(message).slice(0, 2_000),
        timestamp: new Date().toISOString(),
      });
    });
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      broadcastControl(tab);
    });
    page.on("download", (download) => void saveDownload(tab, download));
    updateFileChooserInterception(tab);
    // Popups become tabs and keep `window.opener`, so sign-in popups can report back.
    page.on("popup", (popup) => void adoptPopup(tab, popup));
    // Playwright cannot reload a crashed page, so it must leave the tab list.
    const key = tabKey(tab.threadId, tab.tabId);
    if (closedPendingTabs.delete(key)) {
      await control.close().catch(constVoid);
      throw new ServerBrowserTabNotFoundError({ threadId: tab.threadId, tabId: tab.tabId });
    }
    page.on("close", () => dropTab(tab, true));
    page.on("crash", () => dropTab(tab, true));
    tabs.set(key, tab);
    reportLiveTabs();
    // A desktop page navigates on its own and can finish loading before these listeners attach.
    if (desktop) void page.waitForLoadState("load").then(() => reportLoaded(tab), constVoid);
    // Existing desktop and popup PDFs can start loading before interception attaches.
    if (
      snapshot.navStatus._tag === "Loading" &&
      ((!adopted && !desktop) || isPdfAssetUrl(snapshot.navStatus.url))
    ) {
      const options = { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS } as const;
      tab.initialNavigation = (
        (desktop || adopted) && page.url() === snapshot.navStatus.url
          ? page.reload(options)
          : page.goto(snapshot.navStatus.url, options)
      ).then(constVoid, (cause: unknown) => {
        throw ServerBrowserPage.toOperationError(cause, NAVIGATION_TIMEOUT_MS);
      });

      if (tab.control.agentId !== null) tab.control.track(tab.initialNavigation);
      else void tab.initialNavigation.catch(constVoid);
    }
    return tab;
  };

  const adoptPopup = async (opener: ServerTab, popup: Page) => {
    if (opener.closing) {
      await popup.close().catch(constVoid);
      return;
    }
    const url = popup.url();

    const controller = [...opener.viewers].find(
      (viewer) => viewer.id === opener.control.controller,
    );
    await runPromise(
      openTab({
        threadId: opener.threadId,
        ...(/^https?:/i.test(url) ? { url } : {}),
        runtime: "server",
        ...(opener.profileId === undefined ? {} : { profileId: opener.profileId }),
        ...(opener.control.agentId === null
          ? {}
          : { automationOwner: opener.control.agentId, reveal: false }),
        beforePublish: (snapshot) =>
          adoptedPages.set(tabKey(snapshot.threadId, snapshot.tabId), {
            page: popup,
            openerTabId: opener.tabId,
          }),
      }),
    ).then(
      (tab) => {
        if (opener.control.agentId === null) controller?.push({ _tag: "popup", tabId: tab.tabId });
      },
      async () => {
        await popup.close().catch(constVoid);
      },
    );
  };

  const ensureTab = (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const key = tabKey(snapshot.threadId, snapshot.tabId);
    const pending = pendingTabs.get(key);
    if (pending?.promise) return pending.promise;
    const existing = tabs.get(key);
    if (existing) return Promise.resolve(existing);
    const opening = createTab(snapshot)
      .catch((cause: unknown) => {
        runFork(
          Effect.logWarning(
            isHostSetupError(cause) ? cause.message : "server preview tab failed to start",
            { cause },
          ),
        );
        throw cause;
      })
      .finally(() => {
        pendingTabs.delete(key);
        closedPendingTabs.delete(key);
      });
    pendingTabs.set(key, { agentId: snapshot.automationOwner ?? null, promise: opening });
    return opening;
  };

  const findTab = Effect.fn("ServerBrowser.findTab")(function* (threadId: string, tabId: string) {
    const existing = tabs.get(tabKey(threadId, tabId));
    if (existing) return existing;
    const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
    const snapshot = sessions.find(
      (session) => session.tabId === tabId && session.runtime === "server",
    );
    if (!snapshot) return yield* new ServerBrowserTabNotFoundError({ threadId, tabId });
    return yield* Effect.tryPromise({
      try: () => ensureTab(snapshot),
      catch: (cause) => (isTabNotFound(cause) ? cause : new ServerBrowserLaunchError({ cause })),
    });
  });

  const atTabLimit = (agentSessionId: string) => {
    const opening = [...pendingTabs.entries()].filter(([key]) => !tabs.has(key));
    return (
      tabs.size + opening.length >= SERVER_TAB_LIMIT ||
      [...tabs.values()].filter((tab) => tab.control.agentId === agentSessionId).length +
        opening.filter(([, pending]) => pending.agentId === agentSessionId).length >=
        AGENT_TAB_LIMIT
    );
  };

  const assertTabCapacity = (agentSessionId: string) => {
    if (atTabLimit(agentSessionId))
      throw new BrowserControlInterrupted(
        `Too many server browser tabs are open (${AGENT_TAB_LIMIT} per agent session, ${SERVER_TAB_LIMIT} per server). Close one with t3_preview_close or reuse one from preview_status tabs.`,
        "tabLimit",
      );
  };

  // A Playwright launch must settle before its capacity can be released.
  const openTab = Effect.fn("ServerBrowser.openTab")(function* (
    input: Parameters<typeof manager.open>[0],
  ) {
    let key: string = NodeCrypto.randomUUID();
    const reservation = { agentId: input.automationOwner ?? null };
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          if (input.automationOwner !== undefined) assertTabCapacity(input.automationOwner);
          pendingTabs.set(key, reservation);
        },
        catch: ServerBrowserPage.toOperationError,
      }),
      () =>
        manager
          .open({
            ...input,
            beforePublish: (snapshot) => {
              pendingTabs.delete(key);
              key = tabKey(snapshot.threadId, snapshot.tabId);
              pendingTabs.set(key, reservation);
              input.beforePublish?.(snapshot);
            },
          })
          .pipe(
            Effect.flatMap((snapshot) =>
              Effect.tryPromise({
                try: () => ensureTab(snapshot),
                catch: ServerBrowserPage.toOperationError,
              }).pipe(
                Effect.onError(() =>
                  manager
                    .close({ threadId: ThreadId.make(snapshot.threadId), tabId: snapshot.tabId })
                    .pipe(Effect.ignore),
                ),
              ),
            ),
          ),
      () =>
        Effect.sync(() => {
          pendingTabs.delete(key);
        }),
    );
  }, Effect.uninterruptible);

  // Desktop browsing bypasses streamed viewers and server input tracking,
  // so these idle signals only apply to headless tabs.
  const closeIdleAgentTabs = () => {
    const cutoff = Date.now() - AGENT_TAB_IDLE_MS;
    for (const tab of tabs.values()) {
      if (
        tab.control.agentId !== null &&
        tab.desktop === null &&
        tab.viewers.size === 0 &&
        tab.usedAt < cutoff
      )
        dropTab(tab, true);
    }
  };

  const latestThreadTab = (threadId: string, agentSessionId?: string) => {
    const threadTabs = [...tabs.values()].filter((tab) => tab.threadId === threadId);
    return (
      threadTabs
        .filter((tab) => tab.control.agentId === agentSessionId)
        .sort((left, right) => right.createdAt - left.createdAt)[0] ??
      threadTabs.sort(
        (left, right) =>
          Number(right.viewers.size > 0) - Number(left.viewers.size > 0) ||
          right.usedAt - left.usedAt,
      )[0]
    );
  };

  const tabOwner = (tab: ServerTab) =>
    tab.control.controller !== null
      ? ("human" as const)
      : tab.control.agentId !== null
        ? ("agent" as const)
        : ("unclaimed" as const);

  return { dropTab, sessionOpen, ensureTab, findTab, openTab, closeIdleAgentTabs, latestThreadTab, tabOwner, layoutSize, applySetting, applyRendering, broadcastViewport, createTab, setUpTab, adoptPopup };
};
