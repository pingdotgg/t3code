// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
/**
 * Headless Chromium preview tabs owned by the environment server.
 *
 * Tabs opened with `runtime: "server"` live here instead of in a desktop
 * `<webview>`, so agents keep browsing with no client attached and any client
 * (web, phone, a desktop on another machine) watches through
 * `/api/preview-stream`. PreviewManager stays the tab list: this service
 * mirrors it (`opened` creates a page, `resized` applies the viewport, `closed`
 * drops it) and reports page state back through `reportStatus`, the same path
 * desktops use. Agents reach these tabs through PreviewAutomationBroker, where
 * this service registers as a preferred in-process automation host.
 *
 * Rendering is tuned for servers without a GPU. `--disable-gpu` selects
 * software compositing, which measured about six times cheaper than
 * SwiftShader GL compositing for a busy page; WebGL still works through
 * SwiftShader. Screencast frames ignore emulated device scale, so the process
 * renders at a real 2x for crisp screenshots, recordings, and retina viewers;
 * small viewers get downscaled frames.
 */
import {
  FILL_PREVIEW_VIEWPORT,
  INCOGNITO_BROWSER_PROFILE_ID,
  PREVIEW_AUTOMATION_OPERATIONS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

import { PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import * as ServerBrowserToolchain from "./ServerBrowserToolchain.ts";
import { isServerBrowserEnabled } from "./serverBrowserEnabled.ts";

const SERVER_HOST_CLIENT_ID = "server-browser";
const RENDER_SCALE = 2;
/**
 * Chromium keeps three screencast frames in flight and drops frames past
 * that, so holding each ack this long caps a viewer near 30 fps.
 */
const SCREENCAST_ACK_PACE_MS = 100;
/** Quiet time after which a viewer that may have missed frames gets a still. */
const SCREENCAST_SETTLE_MS = 200;
/**
 * This many frames inside the window, while the viewer is scrolling, is
 * motion. Motion streams at half size and lower quality, and the sharp frame
 * follows once the page settles. Clicks and the page's own animations stay
 * sharp.
 */
const SCREENCAST_MOTION_FRAMES = 4;
const SCREENCAST_MOTION_WINDOW_MS = 300;
const SCREENCAST_MOTION_QUALITY = 50;
const HOST_RECONNECT_DELAY = "1 second";
const VIEWER_OUTPUT_LIMIT = 64;
const RECORDING_SCREENCAST = { format: "jpeg", quality: 90, everyNthFrame: 1 } as const;

/** Resolves at `deadline`, in epoch ms. */
const sleepUntil = (deadline: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));

/**
 * Whether a tap at a page point lands on something that takes text, so a touch
 * viewer raises its soft keyboard only then. Frames count as editable because
 * their contents are out of reach.
 */
const EDITABLE_AT_POINT_SCRIPT = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
}`;
/** Fill-mode size before any viewer reports its panel. */
const UNATTACHED_FILL_VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 15_000;
const ACTION_TIMELINE_LIMIT = 50;

export class ServerBrowserTabNotFoundError extends Schema.TaggedError<ServerBrowserTabNotFoundError>()(
  "ServerBrowserTabNotFoundError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message(): string {
    return "The server preview tab does not exist.";
  }
}

export class ServerBrowserLaunchError extends Schema.TaggedError<ServerBrowserLaunchError>()(
  "ServerBrowserLaunchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server preview browser could not start.";
  }
}

export type ServerBrowserViewerOutput =
  | {
      readonly _tag: "frame";
      readonly data: Uint8Array;
      /** Releases the next frame; call after the bytes reach the socket. */
      readonly ack: Effect.Effect<void>;
    }
  | { readonly _tag: "viewport"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "probe";
      readonly x: number;
      readonly y: number;
      readonly editable: boolean;
    }
  /** The tab closed; the socket ends. */
  | { readonly _tag: "gone" };

export interface ServerBrowserViewer {
  readonly output: Queue.Dequeue<ServerBrowserViewerOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
}

export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    readonly enabled: boolean;
    /** Streams one tab to a viewer until the scope closes. */
    readonly attachViewer: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
    }) => Effect.Effect<
      ServerBrowserViewer,
      ServerBrowserTabNotFoundError | ServerBrowserLaunchError,
      Scope.Scope
    >;
  }
>()("t3/preview/ServerBrowser") {}

interface ViewerState {
  readonly push: (output: ServerBrowserViewerOutput) => void;
  /** Stops and restarts this viewer's screencast around a scaled capture. */
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  /** Last wheel input from this viewer, for motion mode. */
  scrolledAt: number;
  /** Panel bounds, retained in fixed mode; passive viewers never request a size. */
  requestedSize: { width: number; height: number; order: number } | null;
}

interface Recording {
  readonly encoder: Page;
  readonly session: CDPSession;
  readonly startedAt: string;
  /** Frames still being handed to the encoder; stopping waits for them. */
  readonly framesInFlight: Set<Promise<void>>;
}

interface ServerTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly createdAt: number;
  readonly viewers: Set<ViewerState>;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  setting: PreviewViewportSetting;
  loading: boolean;
  closing: boolean;
  recording: Recording | null;
  initialNavigation: Promise<void> | null;
  /** The latest queued start, so a stop can find a recording still starting. */
  recordingStart: Promise<Recording> | null;
  /** Serializes captures and recording start/stop. */
  captureLock: Promise<void>;
  /** Scaled captures rendering now; screencasts stay stopped meanwhile. */
  capturing: number;
}

const tabKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

const pushBounded = <A>(
  buffer: Array<A>,
  entry: A,
  limit = ServerBrowserPage.DIAGNOSTIC_BUFFER_LIMIT,
) => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

const fixedViewportSize = (setting: PreviewViewportSetting | undefined) =>
  setting === undefined || setting._tag === "fill"
    ? null
    : { width: setting.width, height: setting.height };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const modifiersOf = (message: Record<string, unknown>) => {
  const value = num(message.modifiers);
  return Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
};

// Cmd shortcuts from Apple viewers are no editing shortcut for Linux or headless
// Chromium, so they carry the command. Ctrl already works natively on Linux.
const metaEditingCommand = (key: string, modifiers: number) => {
  if ((modifiers & 0b0111) !== 4) return null;
  const lower = key.toLowerCase();
  const command =
    lower === "a" ? "selectAll" : lower === "z" ? (modifiers & 8 ? "redo" : "undo") : null;
  return command ? { commands: [command] } : null;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const enabled = isServerBrowserEnabled(config.mode);
  const manager = yield* PreviewManager.PreviewManager;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const toolchain = yield* ServerBrowserToolchain.ServerBrowserToolchain;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const tabs = new Map<string, ServerTab>();
  const pendingTabs = new Map<string, Promise<ServerTab>>();
  const contexts = new Map<string, Promise<BrowserContext>>();
  let hostConnectionId: string | null = null;
  let viewerResizeOrder = 0;

  const profilesDir = NodePath.join(config.stateDir, "server-browser", "profiles");

  const launchContext = async (profileId: string): Promise<BrowserContext> => {
    const resolved = await Effect.runPromise(toolchain.resolve);
    // Loaded on first use so servers that never open a server tab skip it.
    const { chromium } = await import("playwright-core");
    const launch = async (chromiumSandbox: boolean) => {
      const launchOptions = {
        executablePath: resolved.executablePath,
        env: { ...process.env, ...resolved.env },
        args: [...resolved.args, "--disable-gpu", `--force-device-scale-factor=${RENDER_SCALE}`],
        headless: true,
        chromiumSandbox,
      };
      const contextOptions = {
        viewport: UNATTACHED_FILL_VIEWPORT,
        deviceScaleFactor: RENDER_SCALE,
      };
      if (profileId === INCOGNITO_BROWSER_PROFILE_ID) {
        const browser = await chromium.launch(launchOptions);
        try {
          const context = await browser.newContext(contextOptions);
          context.on("close", () => void browser.close().catch(() => undefined));
          return context;
        } catch (cause) {
          await browser.close().catch(() => undefined);
          throw cause;
        }
      }
      const userDataDir = NodePath.join(profilesDir, encodeURIComponent(profileId));
      await NodeFSP.mkdir(userDataDir, { recursive: true });
      return chromium.launchPersistentContext(userDataDir, { ...launchOptions, ...contextOptions });
    };
    // The namespace sandbox needs unprivileged user namespaces, which some
    // containers disable. Running unsandboxed there matches what the agent
    // already has: a shell as the same user.
    const context = await launch(true).catch(() => launch(false));
    for (const page of context.pages()) await page.close().catch(() => undefined);
    context.on("close", () => {
      contexts.delete(profileId);
      for (const tab of tabs.values()) {
        if (tab.page.context() === context) dropTab(tab, true);
      }
    });
    return context;
  };

  const contextFor = (profileId: string) => {
    let context = contexts.get(profileId);
    if (!context) {
      context = launchContext(profileId);
      contexts.set(profileId, context);
      context.catch(() => contexts.delete(profileId));
    }
    return context;
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
    const title = (await tab.page.title().catch(() => "")).slice(0, 512);
    report(tab, { _tag: "Success", url: url.slice(0, 2048), title });
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

  const broadcastViewport = (tab: ServerTab) => {
    const size = tab.page.viewportSize();
    if (!size) return;
    for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
  };

  const applySetting = async (tab: ServerTab, setting: PreviewViewportSetting) => {
    tab.setting = setting;
    const size =
      fixedViewportSize(setting) ??
      [...tab.viewers]
        .map((viewer) => viewer.requestedSize)
        .filter((requested) => requested !== null)
        .sort((left, right) => right.order - left.order)[0] ??
      UNATTACHED_FILL_VIEWPORT;
    await tab.page.setViewportSize({ width: size.width, height: size.height });
    broadcastViewport(tab);
  };

  const dropTab = (tab: ServerTab, closeSession: boolean) => {
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab) return;
    tabs.delete(key);
    tab.closing = true;
    for (const viewer of tab.viewers) viewer.push({ _tag: "gone" });
    void tab.page.close().catch(() => undefined);
    void tab.recording?.encoder.close().catch(() => undefined);
    reportLiveTabs();
    if (closeSession) {
      runFork(manager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore));
    }
  };

  const createTab = async (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const context = await contextFor(snapshot.profileId ?? "default");
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const tab: ServerTab = {
      threadId: ThreadId.make(snapshot.threadId),
      tabId: snapshot.tabId,
      page,
      cdp,
      createdAt: Date.now(),
      viewers: new Set(),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      setting: snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
      loading: false,
      closing: false,
      recording: null,
      recordingStart: null,
      initialNavigation: null,
      captureLock: Promise.resolve(),
      capturing: 0,
    };
    await page.setViewportSize(fixedViewportSize(tab.setting) ?? UNATTACHED_FILL_VIEWPORT);
    const isMainNavigation = (request: { isNavigationRequest(): boolean; frame(): unknown }) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    page.on("request", (request) => {
      if (!isMainNavigation(request)) return;
      tab.loading = true;
      report(tab, { _tag: "Loading", url: request.url().slice(0, 2048), title: "" });
    });
    page.on("load", () => {
      tab.loading = false;
      void reportLoaded(tab);
    });
    page.on("framenavigated", (frame) => {
      // Same-document navigations (SPA routes) fire no load event.
      if (frame === page.mainFrame() && !tab.loading) void reportLoaded(tab);
    });
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      pushBounded(tab.networkEntries, {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        errorText,
        timestamp: new Date().toISOString(),
      });
      if (!isMainNavigation(request) || errorText.includes("ERR_ABORTED")) return;
      tab.loading = false;
      const { code, description } = ServerBrowserPage.parseNetError(errorText);
      report(tab, {
        _tag: "LoadFailed",
        url: request.url().slice(0, 2048),
        title: "",
        code,
        description,
      });
    });
    page.on("response", (response) => {
      pushBounded(tab.networkEntries, {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: new Date().toISOString(),
      });
    });
    page.on("console", (message) => {
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: message.text().slice(0, 2_000),
        timestamp: new Date().toISOString(),
      });
    });
    // A blocking dialog would freeze the page for every viewer and agent.
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    // One page per tab: a popup becomes a navigation of its opener.
    page.on("popup", (popup) => {
      void popup
        .waitForURL((url) => url.href !== "about:blank", {
          timeout: NAVIGATION_TIMEOUT_MS,
          waitUntil: "commit",
        })
        .catch(() => undefined)
        .then(async () => {
          const url = popup.url();
          await popup.close().catch(() => undefined);
          if (url !== "about:blank") await page.goto(url).catch(() => undefined);
        });
    });
    page.on("close", () => {
      if (!tab.closing) dropTab(tab, true);
    });
    // Playwright cannot reload a crashed page. Remove it so clients stop
    // displaying its stale frame and the agent can open a fresh tab.
    page.on("crash", () => {
      if (!tab.closing) dropTab(tab, true);
    });
    tabs.set(tabKey(tab.threadId, tab.tabId), tab);
    reportLiveTabs();
    if (snapshot.navStatus._tag === "Loading") {
      tab.initialNavigation = page
        .goto(snapshot.navStatus.url, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS })
        .then(() => undefined);
      // Background creation keeps the failed tab; automation awaits the original error.
      void tab.initialNavigation.catch(() => undefined);
    }
    return tab;
  };

  const ensureTab = (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const key = tabKey(snapshot.threadId, snapshot.tabId);
    const pending = pendingTabs.get(key);
    if (pending) return pending;
    const existing = tabs.get(key);
    if (existing) return Promise.resolve(existing);
    const opening = createTab(snapshot).finally(() => pendingTabs.delete(key));
    pendingTabs.set(key, opening);
    return opening;
  };

  /** Server tabs that exist in PreviewManager but have not finished opening here. */
  const findTab = (threadId: string, tabId: string) =>
    Effect.gen(function* () {
      const existing = tabs.get(tabKey(threadId, tabId));
      if (existing) return existing;
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
      const snapshot = sessions.find(
        (session) => session.tabId === tabId && session.runtime === "server",
      );
      if (!snapshot) return yield* new ServerBrowserTabNotFoundError({ threadId, tabId });
      return yield* Effect.tryPromise({
        try: () => ensureTab(snapshot),
        catch: (cause) => new ServerBrowserLaunchError({ cause }),
      });
    });

  const latestThreadTab = (threadId: string) =>
    [...tabs.values()]
      .filter((tab) => tab.threadId === threadId)
      .sort((left, right) => right.createdAt - left.createdAt)[0];

  const statusOf = (tab: ServerTab | undefined): PreviewAutomationStatus => {
    if (!tab) {
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
    }
    const url = tab.page.url();
    const viewport = tab.page.viewportSize();
    return {
      available: true,
      visible: tab.viewers.size > 0,
      tabId: tab.tabId,
      url: url === "about:blank" ? null : url,
      title: null,
      loading: tab.loading,
      viewportSetting: tab.setting,
      ...(viewport ? { viewport } : {}),
    };
  };

  const statusWithTitle = async (tab: ServerTab | undefined) => {
    const status = statusOf(tab);
    if (!tab || status.url === null) return status;
    return { ...status, title: (await tab.page.title().catch(() => "")) || null };
  };

  const resolveNavigationUrl = (input: PreviewAutomationNavigateInput) => {
    if (input.url !== undefined) return normalizePreviewUrl(input.url);
    const target = input.target!;
    if (target.kind === "url") return normalizePreviewUrl(target.url);
    // The browser runs inside the environment, so its ports are loopback.
    const path = target.path ?? "";
    return `${target.protocol ?? "http"}://localhost:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
  };

  const navigate = async (
    tab: ServerTab,
    url: string,
    readiness: "load" | "domContentLoaded" | "none",
    timeout: number,
  ) => {
    const navigation = tab.page.goto(url, {
      timeout,
      waitUntil:
        readiness === "domContentLoaded"
          ? "domcontentloaded"
          : readiness === "none"
            ? "commit"
            : "load",
    });
    if (readiness === "none") {
      void navigation.catch(() => undefined);
      return;
    }
    await navigation.catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/ERR_[A-Z_]+/.test(message)) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `Navigation to ${url} failed: ${ServerBrowserPage.parseNetError(message).description}`,
        );
      }
      throw cause;
    });
  };

  const moveAgentCursor = (
    tab: ServerTab,
    point: { readonly x: number; readonly y: number },
    click: boolean,
  ) => {
    void tab.recording?.encoder
      .evaluate(
        ([x, y, isClick]) => {
          const recorder = (
            globalThis as unknown as {
              __t3Recorder?: { cursor(x: number, y: number, click: boolean): void };
            }
          ).__t3Recorder;
          recorder?.cursor(x, y, isClick);
        },
        [point.x, point.y, click] as const,
      )
      .catch(() => undefined);
  };

  const withCaptureLock = <A>(tab: ServerTab, operation: () => Promise<A>): Promise<A> => {
    const run = tab.captureLock.then(() => {
      if (tab.closing) throw new Error("The preview tab closed.");
      return operation();
    });
    tab.captureLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const startRecording = (tab: ServerTab): Promise<Recording> => {
    const started = withCaptureLock(tab, async () => tab.recording ?? beginRecording(tab)).finally(
      () => {
        if (tab.recordingStart === started) tab.recordingStart = null;
      },
    );
    tab.recordingStart = started;
    return started;
  };

  const beginRecording = async (tab: ServerTab) => {
    const encoder = await tab.page.context().newPage();
    let session: CDPSession | null = null;
    try {
      await encoder.evaluate(ServerBrowserPage.RECORDING_ENCODER_SCRIPT);
      const opened = await tab.page.context().newCDPSession(tab.page);
      session = opened;
      const framesInFlight = new Set<Promise<void>>();
      opened.on("Page.screencastFrame", (frame) => {
        const cssWidth = tab.page.viewportSize()?.width ?? frame.metadata.deviceWidth;
        const delivered: Promise<void> = encoder
          .evaluate(
            ([data, width]) => {
              const recorder = (
                globalThis as unknown as {
                  __t3Recorder: { frame(data: string, width: number): Promise<boolean> };
                }
              ).__t3Recorder;
              return recorder.frame(data, width);
            },
            [frame.data, cssWidth] as const,
          )
          .then(async (accepted) => {
            if (!accepted) await opened.send("Page.stopScreencast");
          })
          .catch(() => undefined)
          .finally(() => {
            framesInFlight.delete(delivered);
            void opened
              .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
              .catch(() => undefined);
          });
        framesInFlight.add(delivered);
      });
      await opened.send("Page.startScreencast", RECORDING_SCREENCAST);
      if (tab.closing) throw new Error("The tab closed while the recording started.");
      const recording: Recording = {
        encoder,
        session: opened,
        startedAt: new Date().toISOString(),
        framesInFlight,
      };
      tab.recording = recording;
      return recording;
    } catch (cause) {
      // A start that fails partway must not leave its encoder page behind.
      await encoder.close().catch(() => undefined);
      await session?.detach().catch(() => undefined);
      throw cause;
    }
  };

  /**
   * Runs a scaled capture with the tab's screencasts stopped, so viewers and
   * recordings never receive the frame it renders at the capture scale.
   */
  const withScreencastsPaused = <A>(tab: ServerTab, capture: () => Promise<A>): Promise<A> =>
    withCaptureLock(tab, async () => {
      tab.capturing += 1;
      const recording = tab.recording;
      try {
        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.pause()),
          recording?.session.send("Page.stopScreencast").catch(() => undefined),
        ]);
        return await capture();
      } finally {
        tab.capturing -= 1;
        // Viewers that attached during the capture start here too.
        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.resume()),
          recording && tab.recording === recording
            ? recording.session
                .send("Page.startScreencast", RECORDING_SCREENCAST)
                .catch(() => undefined)
            : undefined,
        ]);
      }
    });

  const stopRecording = (tab: ServerTab) =>
    withCaptureLock(tab, async () => {
      const recording = tab.recording;
      if (!recording) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationRecordingNotActiveError",
          "No recording is active for this tab.",
        );
      }
      type EncoderWindow = {
        __t3Recorder: {
          stop(): Promise<{ mimeType: string | null; count: number; bytes: number }>;
          chunk(index: number): Promise<string>;
        };
      };
      let mimeType: string | null;
      const chunks: Array<Buffer> = [];
      try {
        await recording.session.send("Page.stopScreencast").catch(() => undefined);
        // The last frames may still be on their way into the encoder.
        await Promise.all(recording.framesInFlight);
        await recording.session.detach().catch(() => undefined);
        const stopped = await recording.encoder.evaluate(() =>
          (globalThis as unknown as EncoderWindow).__t3Recorder.stop(),
        );
        mimeType = stopped.mimeType;
        // Checked before the transfer so an oversized video never lands in this process.
        if (stopped.bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingTooLargeError",
            "The recording is larger than the attachment limit.",
          );
        }
        for (let index = 0; index < stopped.count; index += 1) {
          const chunk = await recording.encoder.evaluate(
            (chunkIndex) => (globalThis as unknown as EncoderWindow).__t3Recorder.chunk(chunkIndex),
            index,
          );
          chunks.push(Buffer.from(chunk, "base64"));
        }
      } finally {
        await recording.encoder.close().catch(() => undefined);
        tab.recording = null;
      }
      const data = Buffer.concat(chunks);
      if (!mimeType || data.byteLength === 0) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          "The recording captured no frames.",
        );
      }
      // Written where a desktop upload would land, so the MCP handler claims
      // both the same way.
      const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}-${extension}`;
      const path = NodePath.join(config.attachmentsDir, `${pendingId}.${extension}`);
      await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
      await NodeFSP.writeFile(path, data);
      return {
        id: pendingId,
        tabId: tab.tabId,
        path,
        mimeType: mimeType.split(";")[0]!,
        sizeBytes: data.byteLength,
        createdAt: new Date().toISOString(),
        uploadedAttachmentId: pendingId,
      };
    });

  const recordAction = <A>(tab: ServerTab, action: string, run: () => Promise<A>): Promise<A> => {
    const event: {
      -readonly [K in keyof PreviewAutomationActionEvent]: PreviewAutomationActionEvent[K];
    } = {
      id: NodeCrypto.randomUUID(),
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    pushBounded(tab.actionTimeline, event, ACTION_TIMELINE_LIMIT);
    return run().then(
      (result) => {
        event.status = "succeeded";
        event.completedAt = new Date().toISOString();
        return result;
      },
      (cause: unknown) => {
        event.status = "failed";
        event.completedAt = new Date().toISOString();
        event.error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
        throw cause;
      },
    );
  };

  const requireTab = async (request: PreviewAutomationRequest) => {
    const tab =
      request.tabId === undefined
        ? latestThreadTab(request.threadId)
        : (tabs.get(tabKey(request.threadId, request.tabId)) ??
          (await Effect.runPromise(
            findTab(request.threadId, request.tabId).pipe(Effect.orElseSucceed(() => undefined)),
          )));
    if (!tab) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationTabNotFoundError",
        "No server preview tab is open for this thread. Call preview_open first.",
      );
    }
    return tab;
  };

  const runOperation = async (request: PreviewAutomationRequest): Promise<unknown> => {
    const input = request.input;
    switch (request.operation) {
      case "status":
        return statusWithTitle(
          request.tabId === undefined
            ? latestThreadTab(request.threadId)
            : tabs.get(tabKey(request.threadId, request.tabId)),
        );
      case "open": {
        const open = input as PreviewAutomationOpenInput;
        const url = open.url === undefined ? undefined : normalizePreviewUrl(open.url);
        const reuse = open.reuseExistingTab ?? true;
        const existing =
          reuse && request.tabId !== undefined
            ? tabs.get(tabKey(request.threadId, request.tabId))
            : undefined;
        const reveal = open.open ?? open.show;
        const revealTab = async (tab: ServerTab) => {
          if (reveal === false) return;
          await Effect.runPromise(
            manager.requestReveal({
              threadId: tab.threadId,
              tabId: tab.tabId,
              force: reveal === true,
            }),
          );
        };
        const navigationTimeout = Math.min(request.timeoutMs, NAVIGATION_TIMEOUT_MS);
        if (existing) {
          if (url) await navigate(existing, url, "load", navigationTimeout);
          await revealTab(existing);
          return statusWithTitle(existing);
        }
        const snapshot = await Effect.runPromise(
          manager.open({
            threadId: request.threadId,
            ...(url ? { url } : {}),
            runtime: "server",
            reveal: false,
          }),
        );
        const tab = await ensureTab(snapshot);
        // Wait for the requested document without blocking manager events for other tabs.
        await tab.initialNavigation;
        await revealTab(tab);
        if (url) {
          await tab.page
            .waitForLoadState("load", { timeout: navigationTimeout })
            .catch(() => undefined);
        }
        return statusWithTitle(tab);
      }
      case "navigate": {
        const tab = await requireTab(request);
        const navigateInput = input as PreviewAutomationNavigateInput;
        await recordAction(tab, "navigate", () =>
          navigate(
            tab,
            resolveNavigationUrl(navigateInput),
            navigateInput.readiness ?? "load",
            navigateInput.timeoutMs ?? request.timeoutMs,
          ),
        );
        return statusWithTitle(tab);
      }
      case "resize": {
        const tab = await requireTab(request);
        const setting = resolvePreviewViewport(input as PreviewAutomationResizeInput);
        await Effect.runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return {
          tabId: tab.tabId,
          setting,
          viewport: tab.page.viewportSize() ?? UNATTACHED_FILL_VIEWPORT,
        };
      }
      case "setColorScheme": {
        const tab = await requireTab(request);
        const { colorScheme } = input as PreviewAutomationSetColorSchemeInput;
        await tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme });
        return { tabId: tab.tabId, colorScheme };
      }
      case "snapshot": {
        const tab = await requireTab(request);
        return withScreencastsPaused(tab, () =>
          ServerBrowserPage.snapshot({
            page: tab.page,
            cdp: tab.cdp,
            renderScale: RENDER_SCALE,
            consoleEntries: tab.consoleEntries,
            networkEntries: tab.networkEntries,
            actionTimeline: tab.actionTimeline,
          }),
        );
      }
      case "click": {
        const tab = await requireTab(request);
        const clickInput = input as PreviewAutomationClickInput;
        const point = await recordAction(tab, "click", () =>
          ServerBrowserPage.click(tab.page, clickInput),
        );
        moveAgentCursor(tab, point, true);
        return undefined;
      }
      case "type": {
        const tab = await requireTab(request);
        await recordAction(tab, "type", () =>
          ServerBrowserPage.type(tab.page, input as PreviewAutomationTypeInput),
        );
        return undefined;
      }
      case "press": {
        const tab = await requireTab(request);
        await recordAction(tab, "press", () =>
          ServerBrowserPage.press(tab.page, input as PreviewAutomationPressInput),
        );
        return undefined;
      }
      case "scroll": {
        const tab = await requireTab(request);
        await recordAction(tab, "scroll", () =>
          ServerBrowserPage.scroll(tab.page, input as PreviewAutomationScrollInput),
        );
        return undefined;
      }
      case "evaluate": {
        const tab = await requireTab(request);
        return ServerBrowserPage.evaluate(tab.cdp, input as PreviewAutomationEvaluateInput);
      }
      case "waitFor": {
        const tab = await requireTab(request);
        await ServerBrowserPage.waitFor(tab.page, input as PreviewAutomationWaitForInput);
        return undefined;
      }
      case "recordingStart": {
        const tab = await requireTab(request);
        const recording = await startRecording(tab);
        return { tabId: tab.tabId, recording: true, startedAt: recording.startedAt };
      }
      case "recordingStop": {
        const recordings = [...tabs.values()].filter(
          (candidate) =>
            candidate.threadId === request.threadId &&
            (candidate.recording || candidate.recordingStart),
        );
        const targetTabId = request.tabId ?? latestThreadTab(request.threadId)?.tabId;
        const tab =
          recordings.find((candidate) => candidate.tabId === targetTabId) ??
          (!request.tabIdExplicit && recordings.length === 1 ? recordings[0] : undefined);
        if (!tab) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingNotActiveError",
            "No recording is active for this thread.",
          );
        }
        return stopRecording(tab);
      }
    }
  };

  const handleRequest = (connectionId: string, request: PreviewAutomationRequest) =>
    Effect.tryPromise({
      try: () => runOperation(request),
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
        await ensureTab(event.snapshot).catch(() => undefined);
        return;
      }
      const tab = tabs.get(tabKey(event.threadId, event.tabId));
      if (!tab) return;
      if (event.type === "resized" && event.snapshot.viewport) {
        await applySetting(tab, event.snapshot.viewport).catch(() => undefined);
      } else if (event.type === "closed") {
        dropTab(tab, false);
      }
    });

  const dispatchViewerInput = async (
    tab: ServerTab,
    session: CDPSession,
    viewer: ViewerState,
    raw: unknown,
  ) => {
    const message = asRecord(raw);
    if (!message) return;
    const modifiers = modifiersOf(message);
    switch (message.type) {
      case "mouse": {
        const action = message.action;
        const type =
          action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
        const button = ["none", "left", "middle", "right"].includes(String(message.button))
          ? (message.button as "none" | "left" | "middle" | "right")
          : "none";
        await session.send("Input.dispatchMouseEvent", {
          type,
          x: num(message.x),
          y: num(message.y),
          button,
          buttons: num(message.buttons),
          clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
          modifiers,
        });
        return;
      }
      case "wheel":
        viewer.scrolledAt = Date.now();
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: num(message.x),
          y: num(message.y),
          deltaX: num(message.deltaX),
          deltaY: num(message.deltaY),
          modifiers,
        });
        return;
      case "key": {
        const key = typeof message.key === "string" ? message.key : "";
        const code = typeof message.code === "string" ? message.code : "";
        const text = typeof message.text === "string" ? message.text : undefined;
        if (message.action === "up") {
          await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
          return;
        }
        await session.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key,
          code,
          modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...metaEditingCommand(key, modifiers),
          windowsVirtualKeyCode: num(
            message.keyCode,
            key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
          ),
        });
        return;
      }
      case "text":
        if (typeof message.text === "string" && message.text.length > 0) {
          await session.send("Input.insertText", { text: message.text.slice(0, 10_000) });
        }
        return;
      case "resize": {
        const width = Math.min(Math.round(num(message.width)), 3840);
        const height = Math.min(Math.round(num(message.height)), 2160);
        if (width < 100 || height < 100) return;
        viewer.requestedSize = { width, height, order: ++viewerResizeOrder };
        if (tab.setting._tag !== "fill") return;
        const current = tab.page.viewportSize();
        if (current?.width === width && current.height === height) return;
        await tab.page.setViewportSize({ width, height });
        broadcastViewport(tab);
        return;
      }
      case "navigate":
        if (typeof message.url === "string") {
          const url = normalizePreviewUrl(message.url);
          void tab.page.goto(url).catch(() => undefined);
        }
        return;
      case "history":
        void (num(message.delta) < 0 ? tab.page.goBack() : tab.page.goForward()).catch(
          () => undefined,
        );
        return;
      case "reload":
        void tab.page.reload().catch(() => undefined);
        return;
      case "probe": {
        const x = num(message.x);
        const y = num(message.y);
        const result = await session.send("Runtime.evaluate", {
          expression: `(${EDITABLE_AT_POINT_SCRIPT})(${x}, ${y})`,
          returnByValue: true,
        });
        viewer.push({ _tag: "probe", x, y, editable: result.result.value === true });
        return;
      }
    }
  };

  const attachViewer: ServerBrowser["Service"]["attachViewer"] = (input) =>
    Effect.gen(function* () {
      const tab = yield* findTab(input.threadId, input.tabId);
      const output = yield* Queue.make<ServerBrowserViewerOutput>({
        capacity: VIEWER_OUTPUT_LIMIT,
        strategy: "dropping",
      });
      const session = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => tab.page.context().newCDPSession(tab.page),
          catch: (cause) => new ServerBrowserLaunchError({ cause }),
        }),
        (session) =>
          Effect.promise(() =>
            session
              .send("Page.stopScreencast")
              .catch(() => undefined)
              .then(() => session.detach())
              .catch(() => undefined),
          ),
      );
      const quality = Math.min(100, Math.max(1, Math.round(input.quality)));
      // Frames that arrive while others are in flight may have pushed later ones
      // out, and a page that then goes still never repaints them. A still
      // after the burst shows the final state.
      let framesInFlight = 0;
      let mayHaveDropped = false;
      let motion = false;
      const recentFrames: Array<number> = [];
      let screencastParams = Promise.resolve();
      let screencastScale = 1;
      const startScreencast = (scale: number) => {
        screencastScale = scale;
        screencastParams = screencastParams.then(async () => {
          // A scaled capture is rendering; its resume starts the stream.
          if (tab.capturing > 0) return;
          await session.send("Page.stopScreencast").catch(() => undefined);
          await session
            .send("Page.startScreencast", {
              format: "jpeg",
              quality: screencastScale < 1 ? Math.min(quality, SCREENCAST_MOTION_QUALITY) : quality,
              maxWidth: Math.max(1, Math.round(input.maxWidth * screencastScale)),
              maxHeight: Math.max(1, Math.round(input.maxHeight * screencastScale)),
            })
            .catch(() => undefined);
        });
        return screencastParams;
      };
      const viewer: ViewerState = {
        push: (next) => {
          // Bounded: a viewer that stops reading drops messages instead of
          // growing this queue. A dropped frame still releases Chromium.
          if (!Queue.offerUnsafe(output, next) && next._tag === "frame") runFork(next.ack);
        },
        pause: () => {
          screencastParams = screencastParams.then(() =>
            session.send("Page.stopScreencast").then(
              () => undefined,
              () => undefined,
            ),
          );
          return screencastParams;
        },
        resume: () => startScreencast(screencastScale),
        scrolledAt: 0,
        requestedSize: null,
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          tab.viewers.add(viewer);
          reportLiveTabs();
        }),
        () =>
          Effect.sync(() => {
            tab.viewers.delete(viewer);
            reportLiveTabs();
          }),
      );
      // Full scale: a scaled capture would flash in every other viewer.
      const pushStill = async () => {
        const data = await withCaptureLock(tab, () =>
          ServerBrowserPage.captureViewport(tab.page, session, {
            format: "jpeg",
            quality,
            scale: 1,
          }),
        ).catch(() => null);
        if (data)
          viewer.push({ _tag: "frame", data: Buffer.from(data, "base64"), ack: Effect.void });
      };
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (settleTimer !== null) clearTimeout(settleTimer);
        }),
      );
      let screencastStarted = false;
      session.on("Page.screencastFrame", (frame) => {
        screencastStarted = true;
        if (framesInFlight > 0) mayHaveDropped = true;
        framesInFlight += 1;
        const arrivedAt = Date.now();
        recentFrames.push(arrivedAt);
        while (recentFrames[0]! < arrivedAt - SCREENCAST_MOTION_WINDOW_MS) recentFrames.shift();
        if (
          !motion &&
          recentFrames.length >= SCREENCAST_MOTION_FRAMES &&
          arrivedAt - viewer.scrolledAt < SCREENCAST_MOTION_WINDOW_MS
        ) {
          motion = true;
          void startScreencast(0.5);
        } else if (motion && arrivedAt - viewer.scrolledAt > SCREENCAST_SETTLE_MS) {
          // The page keeps animating after the scroll; its own frames are sharp again.
          motion = false;
          recentFrames.length = 0;
          void startScreencast(1);
        }
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (!motion && !mayHaveDropped) return;
          mayHaveDropped = false;
          if (motion) {
            motion = false;
            recentFrames.length = 0;
            void startScreencast(1);
          }
          void pushStill();
        }, SCREENCAST_SETTLE_MS);
        viewer.push({
          _tag: "frame",
          data: Buffer.from(frame.data, "base64"),
          ack: Effect.promise(() =>
            sleepUntil(arrivedAt + SCREENCAST_ACK_PACE_MS).then(() => {
              framesInFlight -= 1;
              return session
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(() => undefined);
            }),
          ),
        });
      });
      broadcastViewport(tab);
      yield* Effect.promise(() => startScreencast(1));
      // An idle page does not repaint for a new screencast, so the viewer
      // starts from a still unless a live frame beat it.
      if (!screencastStarted) yield* Effect.promise(pushStill);
      return {
        output,
        input: (message: unknown) =>
          Effect.promise(() =>
            dispatchViewerInput(tab, session, viewer, message).catch(() => undefined),
          ),
      } satisfies ServerBrowserViewer;
    });

  if (enabled) {
    yield* manager.events.pipe(Stream.runForEach(mirrorManagerEvent), Effect.forkScoped);
    const environmentId = yield* environment.getEnvironmentId;
    const hostSession = broker
      .connect(
        {
          clientId: SERVER_HOST_CLIENT_ID,
          environmentId,
          supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
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
    // The broker ends a host's stream when a request outlives its deadline,
    // e.g. the first open while Chromium installs. Register again, or agents
    // lose the browser until the server restarts.
    yield* hostSession.pipe(
      Effect.exit,
      Effect.andThen(Effect.sleep(HOST_RECONNECT_DELAY)),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const context of contexts.values()) {
          await context.then((resolved) => resolved.close()).catch(() => undefined);
        }
      }),
    );
  }

  return ServerBrowser.of({ enabled, attachViewer });
});

export const layer = Layer.effect(ServerBrowser, make);
