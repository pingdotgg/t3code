import * as NodeCrypto from "node:crypto";

import {
  PreviewAutomationEngineError,
  PreviewAutomationEngineUnavailableError,
  type PreviewAutomationClickInput,
  type PreviewAutomationError,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationOperation,
  type PreviewAutomationPressInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
  PreviewEngineLaunchError,
  type PreviewInputEvent,
  type PreviewNavStatus,
  PreviewTabId,
  type PreviewBrowserEngine,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import playwrightPackage from "playwright-core/package.json" with { type: "json" };

import type { McpInvocationScope } from "./McpInvocationContext.ts";

export interface PlaywrightPreviewInvokeInput {
  readonly scope: Pick<McpInvocationScope, "environmentId" | "providerSessionId">;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export type EngineViewEvent =
  | {
      readonly type: "status";
      readonly navStatus: PreviewNavStatus;
      readonly canGoBack: boolean;
      readonly canGoForward: boolean;
    }
  | { readonly type: "closed" };

export interface EngineView {
  readonly tabId: PreviewTabId;
  /** Server-relative frame stream URL. The path carries a per-tab secret. */
  readonly frameUrl: string;
  /** Ends when the page closes. */
  readonly events: Stream.Stream<EngineViewEvent>;
}

export interface EngineViewOpenInput {
  readonly owner: string;
  readonly engine: PreviewBrowserEngine;
  readonly url?: string | undefined;
}

export const ENGINE_FRAMES_ROUTE_PREFIX = "/api/preview/frames";

export class PlaywrightPreviewHost extends Context.Service<
  PlaywrightPreviewHost,
  {
    readonly installedEngines: Effect.Effect<ReadonlyArray<PreviewBrowserEngine>>;
    readonly invoke: <A = unknown>(
      input: PlaywrightPreviewInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
    /** Opens a headless page a browser tab drives. Page failures arrive as `status` events. */
    readonly openView: (
      input: EngineViewOpenInput,
    ) => Effect.Effect<
      EngineView,
      PreviewAutomationEngineUnavailableError | PreviewEngineLaunchError
    >;
    readonly navigateView: (tabId: PreviewTabId, url: string) => Effect.Effect<void>;
    readonly reloadView: (tabId: PreviewTabId) => Effect.Effect<void>;
    readonly resizeView: (
      tabId: PreviewTabId,
      viewport: PreviewViewportSetting,
    ) => Effect.Effect<void>;
    readonly sendInput: (tabId: PreviewTabId, event: PreviewInputEvent) => Effect.Effect<void>;
    /** JPEG frames while the page repaints. `undefined` when the tab or secret is unknown. */
    readonly frames: (tabId: PreviewTabId, secret: string) => Stream.Stream<Uint8Array> | undefined;
    readonly closeView: (tabId: PreviewTabId) => Effect.Effect<void>;
  }
>()("t3/mcp/PlaywrightPreviewHost") {}

const ENGINE_TAB_PREFIX = "engine-";
/** Playwright names its downloads after browsers, not engines. */
const ENGINES = {
  blink: { browserType: chromium, download: "chromium" },
  gecko: { browserType: firefox, download: "firefox" },
  webkit: { browserType: webkit, download: "webkit" },
} as const;
const ENGINE_NAMES = Object.keys(ENGINES) as ReadonlyArray<PreviewBrowserEngine>;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const IDLE_CLOSE_MS = 10 * 60_000;
const FRAME_JPEG_QUALITY = 80;
/** View pages render at 2x so the settled frame is sharp on a retina display. */
const FRAME_SCALE = 2;
const SETTLE_MS = 200;
const MAX_LOG_ENTRIES = 200;
const MAX_ELEMENTS = 200;
const MAX_EVALUATE_RESULT_CHARS = 64_000;

export const isEngineTabId = (tabId: string): boolean => tabId.startsWith(ENGINE_TAB_PREFIX);

/** Playwright drives its own Firefox and WebKit builds only. Stock Chrome and Edge work as Blink. */
const stockBlinkPaths = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ];
    case "win32":
      return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
        .filter((root): root is string => Boolean(root))
        .flatMap((root) => [
          `${root}\\Google\\Chrome\\Application\\chrome.exe`,
          `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]);
    default:
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
      ];
  }
};

export const resolveNavigationUrl = (
  input: Pick<PreviewAutomationNavigateInput, "url" | "target">,
): string => {
  if (input.url !== undefined) return normalizePreviewUrl(input.url);
  if (input.target?.kind === "url") return normalizePreviewUrl(input.target.url);
  if (input.target?.kind === "environment-port") {
    const path = input.target.path ?? "";
    const separator = path === "" || path.startsWith("/") ? "" : "/";
    return `${input.target.protocol ?? "http"}://localhost:${input.target.port}${separator}${path}`;
  }
  throw new Error("Provide a url or a target.");
};

/** Runs inside the page, so it is plain JavaScript: the server compiles without DOM types. */
const INTERACTIVE_ELEMENTS_SCRIPT = String.raw`(limit) => {
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href") ? "link" : null;
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    return null;
  };
  const cssPath = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 6) {
      const parent = current.parentElement;
      const tag = current.tagName.toLowerCase();
      const siblings = parent
        ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
        : [];
      parts.unshift(
        siblings.length > 1 ? tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : tag,
      );
      current = parent;
    }
    return parts.join(" > ");
  };
  const selector =
    "a[href], button, input, select, textarea, summary, [role], [contenteditable='true'], [tabindex]";
  const results = [];
  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (results.length >= limit) break;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const name = (
      element.getAttribute("aria-label") ||
      (element.innerText || "").trim() ||
      element.placeholder ||
      element.value ||
      element.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .slice(0, 200);
    results.push({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") ?? implicitRole(element),
      name,
      selector: cssPath(element),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  return results;
}`;

interface EngineViewState {
  readonly secret: string;
  readonly events: Queue.Queue<EngineViewEvent, Cause.Done<void>>;
  readonly frameSinks: Set<Queue.Queue<Uint8Array, Cause.Done>>;
  /** Every new frame's sequence number. The settle fiber waits for it to go quiet. */
  readonly frameSignals: Queue.Queue<number, Cause.Done<void>>;
  lastFrame: Uint8Array | undefined;
  frameSeq: number;
  /** Set by a back or forward move so the next navigation keeps the forward count. */
  historyMove: boolean;
  forwardSteps: number;
}

interface EngineTab {
  readonly tabId: PreviewTabId;
  readonly owner: string;
  readonly engine: PreviewBrowserEngine;
  /** Present on pages a browser tab drives. */
  readonly view: EngineViewState | undefined;
  readonly browser: Browser;
  readonly page: Page;
  readonly consoleEntries: Array<PreviewAutomationSnapshot["consoleEntries"][number]>;
  readonly networkEntries: Array<PreviewAutomationSnapshot["networkEntries"][number]>;
  viewportSetting: PreviewViewportSetting;
  lastUsedAt: number;
}

const pushBounded = <A>(entries: Array<A>, entry: A) => {
  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
};

const errorDetail = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split("\n")[0]?.slice(0, 500) ?? "Unknown error";
};

const locatorFor = (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
) => {
  const target = input.locator ?? input.selector;
  return target === undefined ? undefined : page.locator(target);
};

const tabStatus = (tab: EngineTab): PreviewAutomationStatus => ({
  available: true,
  visible: false,
  tabId: tab.tabId,
  url: tab.page.url(),
  title: "",
  loading: false,
  engine: tab.engine,
  viewportSetting: tab.viewportSetting,
  viewport: tab.page.viewportSize() ?? DEFAULT_VIEWPORT,
});

const make = Effect.gen(function* PlaywrightPreviewHostMake() {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const scope = yield* Effect.scope;
  const tabs = new Map<PreviewTabId, EngineTab>();
  const openLock = yield* Semaphore.make(1);
  let tabSequence = 0;

  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      Promise.allSettled(Array.from(tabs.values(), (tab) => tab.browser.close())),
    ),
  );

  const executablePath = Effect.fn("PlaywrightPreviewHost.executablePath")(function* (
    engine: PreviewBrowserEngine,
  ) {
    const candidates = [
      ENGINES[engine].browserType.executablePath(),
      ...(engine === "blink" ? stockBlinkPaths(platform, env) : []),
    ];
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return undefined;
  });

  const installedEngines = Effect.forEach(ENGINE_NAMES, (engine) =>
    Effect.map(executablePath(engine), (path) => (path === undefined ? [] : [engine])),
  ).pipe(Effect.map((found) => found.flat()));

  const closeTab = (tab: EngineTab) =>
    Effect.promise(() => tab.browser.close().catch(() => undefined)).pipe(
      Effect.tap(() => Effect.sync(() => tabs.delete(tab.tabId))),
    );

  const closeIdleTabs = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      Array.from(tabs.values()).filter(
        (tab) => tab.view === undefined && now - tab.lastUsedAt > IDLE_CLOSE_MS,
      ),
      closeTab,
      { discard: true },
    );
  });
  yield* Effect.forkScoped(closeIdleTabs.pipe(Effect.delay(IDLE_CLOSE_MS), Effect.forever));

  const openTab = Effect.fn("PlaywrightPreviewHost.openTab")(function* (
    owner: string,
    engine: PreviewBrowserEngine,
    view?: EngineViewState,
  ) {
    const path = yield* executablePath(engine);
    if (path === undefined) {
      return yield* new PreviewAutomationEngineUnavailableError({
        engine,
        installedEngines: yield* installedEngines,
        installCommand: `npx playwright-core@${playwrightPackage.version} install ${ENGINES[engine].download}`,
      });
    }
    const tabId = PreviewTabId.make(`${ENGINE_TAB_PREFIX}${engine}-${++tabSequence}`);
    const { browser, page } = yield* Effect.tryPromise({
      try: async () => {
        const browser = await ENGINES[engine].browserType.launch({ executablePath: path });
        try {
          const page = await browser.newPage({
            viewport: DEFAULT_VIEWPORT,
            ...(view === undefined ? {} : { deviceScaleFactor: FRAME_SCALE }),
          });
          return { browser, page };
        } catch (cause) {
          await browser.close().catch(() => undefined);
          throw cause;
        }
      },
      catch: (cause) =>
        new PreviewAutomationEngineError({
          operation: "open",
          engine,
          tabId,
          detail: errorDetail(cause),
        }),
    });
    const tab: EngineTab = {
      tabId,
      owner,
      engine,
      view,
      browser,
      page,
      consoleEntries: [],
      networkEntries: [],
      viewportSetting: { _tag: "freeform", ...DEFAULT_VIEWPORT },
      lastUsedAt: yield* Clock.currentTimeMillis,
    };
    page.on("console", (message) =>
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: message.text(),
        timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
      }),
    );
    page.on("response", (response) =>
      pushBounded(tab.networkEntries, {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
      }),
    );
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      pushBounded(tab.networkEntries, {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        ...(failure === null ? {} : { errorText: failure.errorText }),
        timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
      });
    });
    browser.on("disconnected", () => tabs.delete(tabId));
    tabs.set(tabId, tab);
    return tab;
  });

  const openOrReuseTab = (owner: string, input: PreviewAutomationOpenInput) =>
    openLock.withPermit(
      Effect.suspend(() => {
        const engine = input.engine ?? "blink";
        const current =
          input.reuseExistingTab === false
            ? undefined
            : Array.from(tabs.values()).find((tab) => tab.owner === owner && tab.engine === engine);
        return current === undefined ? openTab(owner, engine) : Effect.succeed(current);
      }),
    );

  const run = <A>(
    tab: EngineTab,
    operation: PreviewAutomationOperation,
    body: () => Promise<A>,
  ): Effect.Effect<A, PreviewAutomationEngineError> =>
    Effect.tryPromise({
      try: body,
      catch: (cause) =>
        new PreviewAutomationEngineError({
          operation,
          engine: tab.engine,
          tabId: tab.tabId,
          detail: errorDetail(cause),
        }),
    });

  const waitUntil = (readiness: PreviewAutomationNavigateInput["readiness"]) =>
    readiness === "none"
      ? "commit"
      : readiness === "domContentLoaded"
        ? "domcontentloaded"
        : "load";

  const snapshot = (tab: EngineTab, timeout: number) =>
    run(tab, "snapshot", async (): Promise<PreviewAutomationSnapshot> => {
      const { page } = tab;
      const [title, visibleText, interactiveElements, png] = await Promise.all([
        page.title(),
        page
          .locator("body")
          .innerText({ timeout })
          .catch(() => ""),
        page.evaluate(`(${INTERACTIVE_ELEMENTS_SCRIPT})(${MAX_ELEMENTS})`) as Promise<
          PreviewAutomationSnapshot["interactiveElements"]
        >,
        page.screenshot({ type: "png", timeout }),
      ]);
      const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
      return {
        url: page.url(),
        title,
        loading: false,
        visibleText: visibleText.trim(),
        interactiveElements,
        accessibilityTree: null,
        consoleEntries: [...tab.consoleEntries],
        networkEntries: [...tab.networkEntries],
        actionTimeline: [],
        screenshot: {
          mimeType: "image/png",
          data: png.toString("base64"),
          width: viewport.width,
          height: viewport.height,
        },
      };
    });

  const invokeOnTab = Effect.fn("PlaywrightPreviewHost.invokeOnTab")(function* (
    tab: EngineTab,
    operation: PreviewAutomationOperation,
    rawInput: unknown,
    timeout: number,
  ): Effect.fn.Return<unknown, PreviewAutomationError> {
    const { page } = tab;
    switch (operation) {
      case "status":
        return yield* run(tab, operation, async () => ({
          ...tabStatus(tab),
          title: await page.title(),
        }));
      case "open": {
        const input = rawInput as PreviewAutomationOpenInput;
        return yield* run(tab, operation, async () => {
          if (input.url !== undefined) {
            await page.goto(normalizePreviewUrl(input.url), { timeout, waitUntil: "load" });
          }
          return { ...tabStatus(tab), title: await page.title() };
        });
      }
      case "navigate": {
        const input = rawInput as PreviewAutomationNavigateInput;
        return yield* run(tab, operation, async () => {
          await page.goto(resolveNavigationUrl(input), {
            timeout,
            waitUntil: waitUntil(input.readiness),
          });
          return { ...tabStatus(tab), title: await page.title() };
        });
      }
      case "resize": {
        const input = rawInput as PreviewAutomationResizeInput;
        return yield* run(tab, operation, async (): Promise<PreviewAutomationResizeResult> => {
          const setting = resolvePreviewViewport(input);
          const size = setting._tag === "fill" ? DEFAULT_VIEWPORT : setting;
          await page.setViewportSize({ width: size.width, height: size.height });
          tab.viewportSetting = setting;
          return {
            tabId: tab.tabId,
            setting,
            viewport: { width: size.width, height: size.height },
          };
        });
      }
      case "setColorScheme": {
        const input = rawInput as PreviewAutomationSetColorSchemeInput;
        return yield* run(
          tab,
          operation,
          async (): Promise<PreviewAutomationSetColorSchemeResult> => {
            await page.emulateMedia({
              colorScheme: input.colorScheme === "system" ? null : input.colorScheme,
            });
            return { tabId: tab.tabId, colorScheme: input.colorScheme };
          },
        );
      }
      case "snapshot":
        return yield* snapshot(tab, timeout);
      case "click": {
        const input = rawInput as PreviewAutomationClickInput;
        return yield* run(tab, operation, async () => {
          const locator = locatorFor(page, input);
          if (locator) await locator.click({ timeout });
          else await page.mouse.click(input.x ?? 0, input.y ?? 0);
        });
      }
      case "type": {
        const input = rawInput as PreviewAutomationTypeInput;
        return yield* run(tab, operation, async () => {
          const locator = locatorFor(page, input);
          if (locator) {
            if (input.clear) await locator.fill(input.text, { timeout });
            else await locator.pressSequentially(input.text, { timeout });
            return;
          }
          if (input.clear) await page.keyboard.press("ControlOrMeta+a");
          await page.keyboard.type(input.text);
        });
      }
      case "press": {
        const input = rawInput as PreviewAutomationPressInput;
        return yield* run(tab, operation, () =>
          page.keyboard.press([...(input.modifiers ?? []), input.key].join("+")),
        );
      }
      case "scroll": {
        const input = rawInput as PreviewAutomationScrollInput;
        const delta = { x: input.deltaX ?? 0, y: input.deltaY ?? 0 };
        return yield* run(tab, operation, async () => {
          const locator = locatorFor(page, input);
          if (locator) {
            await locator.evaluate((element, d) => element.scrollBy(d.x, d.y), delta, { timeout });
          } else {
            await page.mouse.wheel(delta.x, delta.y);
          }
        });
      }
      case "evaluate": {
        const input = rawInput as PreviewAutomationEvaluateInput;
        return yield* run(tab, operation, async () => {
          const value: unknown = await page.evaluate(input.expression);
          const encoded = JSON.stringify(value ?? null);
          if (encoded.length > MAX_EVALUATE_RESULT_CHARS) {
            throw new Error(`Result exceeds ${MAX_EVALUATE_RESULT_CHARS} characters.`);
          }
          return value ?? null;
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              closeTab(tab).pipe(
                Effect.andThen(
                  new PreviewAutomationEngineError({
                    operation,
                    engine: tab.engine,
                    tabId: tab.tabId,
                    detail: `Evaluation did not finish in ${timeout} ms. The tab was closed.`,
                  }),
                ),
              ),
          }),
        );
      }
      case "waitFor": {
        const input = rawInput as PreviewAutomationWaitForInput;
        return yield* run(tab, operation, async () => {
          const locator = locatorFor(page, input);
          if (locator) await locator.first().waitFor({ timeout });
          if (input.text !== undefined) {
            await page.waitForFunction(
              `document.body.innerText.includes(${JSON.stringify(input.text)})`,
              undefined,
              { timeout },
            );
          }
          if (input.urlIncludes !== undefined) {
            const needle = input.urlIncludes;
            await page.waitForURL((url) => url.href.includes(needle), { timeout });
          }
        });
      }
      case "recordingStart":
      case "recordingStop":
        return yield* new PreviewAutomationEngineError({
          operation,
          engine: tab.engine,
          tabId: tab.tabId,
          detail: "Recording is not supported in engine tabs. Use preview_snapshot screenshots.",
        });
    }
  });

  const invoke = Effect.fn("PlaywrightPreviewHost.invoke")(function* <A = unknown>(
    input: PlaywrightPreviewInvokeInput,
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const owner = `${input.scope.environmentId}\u0000${input.scope.providerSessionId}`;
    const found = input.tabId === undefined ? undefined : tabs.get(input.tabId);
    const existing = found?.owner === owner ? found : undefined;
    if (existing === undefined && input.tabId !== undefined) {
      return yield* new PreviewAutomationEngineError({
        operation: input.operation,
        tabId: input.tabId,
        detail: "Tab is closed or unknown. Call preview_open with engine to start a new one.",
      });
    }
    const tab =
      existing ??
      (input.operation === "open"
        ? yield* openOrReuseTab(owner, input.input as PreviewAutomationOpenInput)
        : undefined);
    if (tab === undefined) {
      return yield* new PreviewAutomationEngineError({
        operation: input.operation,
        detail: "Engine tabs need a tabId. Call preview_open with engine first.",
      });
    }
    tab.lastUsedAt = yield* Clock.currentTimeMillis;
    return (yield* invokeOnTab(tab, input.operation, input.input, timeout)) as A;
  });

  const reportView = (tab: EngineTab, navStatus: PreviewNavStatus, canGoBack = false) => {
    if (tab.view === undefined) return;
    Queue.offerUnsafe(tab.view.events, {
      type: "status",
      navStatus,
      canGoBack,
      canGoForward: tab.view.forwardSteps > 0,
    });
  };

  const gotoView = (tab: EngineTab, url: string) =>
    Effect.promise(() =>
      tab.page.goto(url).then(
        () => undefined,
        (cause: unknown) =>
          reportView(tab, {
            _tag: "LoadFailed",
            url,
            title: "",
            code: -1,
            description: errorDetail(cause),
          }),
      ),
    );

  const openView: PlaywrightPreviewHost["Service"]["openView"] = Effect.fn(
    "PlaywrightPreviewHost.openView",
  )(function* (input) {
    const view: EngineViewState = {
      secret: NodeCrypto.randomBytes(18).toString("base64url"),
      events: yield* Queue.unbounded<EngineViewEvent, Cause.Done<void>>(),
      frameSinks: new Set(),
      frameSignals: yield* Queue.unbounded<number, Cause.Done<void>>(),
      lastFrame: undefined,
      frameSeq: 0,
      historyMove: false,
      forwardSteps: 0,
    };
    const tab = yield* openTab(input.owner, input.engine, view).pipe(
      Effect.catchTag(
        "PreviewAutomationEngineError",
        (error) => new PreviewEngineLaunchError({ engine: input.engine, detail: error.detail }),
      ),
    );
    const { page } = tab;
    // A new page loads about:blank on its own. The tab stays Idle, so the
    // empty state with the local servers shows until the user picks a URL.
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || frame.url() === "about:blank") return;
      if (!view.historyMove) view.forwardSteps = 0;
      view.historyMove = false;
      reportView(tab, { _tag: "Loading", url: frame.url(), title: "" });
    });
    page.on("load", () => {
      const url = page.url();
      if (url === "about:blank") return;
      void Promise.all([
        page.title().catch(() => ""),
        page.evaluate("history.length > 1").catch(() => false),
      ]).then(([title, canGoBack]) =>
        reportView(tab, { _tag: "Success", url, title }, canGoBack === true),
      );
    });
    page.on("close", () => {
      Queue.endUnsafe(view.frameSignals);
      Queue.offerUnsafe(view.events, { type: "closed" });
      Queue.endUnsafe(view.events);
      for (const sink of view.frameSinks) Queue.endUnsafe(sink);
      view.frameSinks.clear();
    });
    yield* Effect.forkIn(sendSettledFrames(page, view), scope);
    if (input.url !== undefined) yield* Effect.forkIn(gotoView(tab, input.url), scope);
    return {
      tabId: tab.tabId,
      frameUrl: `${ENGINE_FRAMES_ROUTE_PREFIX}/${tab.tabId}/${view.secret}`,
      events: Stream.fromQueue(view.events),
    };
  });

  const viewTab = (tabId: PreviewTabId) => {
    const tab = tabs.get(tabId);
    return tab?.view === undefined ? undefined : tab;
  };

  const ignoreFailure = (run: () => Promise<unknown>) =>
    Effect.promise(() =>
      run().then(
        () => undefined,
        () => undefined,
      ),
    );

  const navigateView: PlaywrightPreviewHost["Service"]["navigateView"] = (tabId, url) => {
    const tab = viewTab(tabId);
    return tab === undefined ? Effect.void : gotoView(tab, url);
  };

  const reloadView: PlaywrightPreviewHost["Service"]["reloadView"] = (tabId) => {
    const tab = viewTab(tabId);
    if (tab === undefined) return Effect.void;
    return Effect.promise(() =>
      tab.page.reload().then(
        () => undefined,
        (cause: unknown) =>
          reportView(tab, {
            _tag: "LoadFailed",
            url: tab.page.url(),
            title: "",
            code: -1,
            description: errorDetail(cause),
          }),
      ),
    );
  };

  const resizeView: PlaywrightPreviewHost["Service"]["resizeView"] = (tabId, viewport) => {
    const tab = viewTab(tabId);
    if (tab?.view === undefined) return Effect.void;
    const { page, view } = tab;
    const size = viewport._tag === "fill" ? DEFAULT_VIEWPORT : viewport;
    tab.viewportSetting = viewport;
    return ignoreFailure(async () => {
      await page.setViewportSize({ width: size.width, height: size.height });
      if (view.frameSinks.size === 0) return;
      await stopScreencast(page, view);
      await startScreencast(page, view);
    });
  };

  const sendInput: PlaywrightPreviewHost["Service"]["sendInput"] = (tabId, event) => {
    const tab = viewTab(tabId);
    if (tab === undefined || tab.view === undefined) return Effect.void;
    const { page, view } = tab;
    switch (event.type) {
      case "mouseMove":
        return ignoreFailure(() => page.mouse.move(event.x, event.y));
      case "mouseDown":
        return ignoreFailure(async () => {
          await page.mouse.move(event.x, event.y);
          await page.mouse.down({ button: event.button });
        });
      case "mouseUp":
        return ignoreFailure(async () => {
          await page.mouse.move(event.x, event.y);
          await page.mouse.up({ button: event.button });
        });
      case "wheel":
        return ignoreFailure(async () => {
          await page.mouse.move(event.x, event.y);
          await page.mouse.wheel(event.deltaX, event.deltaY);
        });
      case "keyDown":
        return ignoreFailure(() => page.keyboard.down(event.key));
      case "keyUp":
        return ignoreFailure(() => page.keyboard.up(event.key));
      case "history":
        view.historyMove = true;
        view.forwardSteps += event.delta === -1 ? 1 : -1;
        return ignoreFailure(() => (event.delta === -1 ? page.goBack() : page.goForward()));
    }
  };

  const pushFrame = (view: EngineViewState, data: Uint8Array) => {
    for (const sink of view.frameSinks) Queue.offerUnsafe(sink, data);
  };

  // Both engines cap screencast frames at the CSS viewport size, so motion
  // streams at 1x. When frames stop, one 2x PNG screenshot makes text sharp.
  // It is dropped when a new frame lands while the screenshot is in flight.
  const sendSettledFrames = (page: Page, view: EngineViewState) =>
    Effect.forever(
      Effect.gen(function* () {
        let seq = yield* Queue.take(view.frameSignals);
        while (true) {
          const next = yield* Effect.raceFirst(
            Queue.take(view.frameSignals),
            Effect.as(Effect.sleep(SETTLE_MS), undefined),
          );
          if (next === undefined) break;
          seq = next;
        }
        const png = yield* Effect.promise(() =>
          page.screenshot({ type: "png" }).catch(() => undefined),
        );
        if (png !== undefined && view.frameSeq === seq && view.frameSinks.size > 0) {
          pushFrame(view, png);
        }
      }),
    );

  // Playwright fixes the frame size when the screencast starts and downsizes to
  // 800px when no size is given. Firefox repeats identical frames at 25 fps, so
  // duplicates are dropped here.
  const startScreencast = (page: Page, view: EngineViewState) => {
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    return page.screencast.start({
      size: { width: viewport.width * FRAME_SCALE, height: viewport.height * FRAME_SCALE },
      quality: FRAME_JPEG_QUALITY,
      onFrame: ({ data }) => {
        if (view.lastFrame !== undefined && Buffer.from(view.lastFrame).equals(data)) return;
        view.lastFrame = data;
        view.frameSeq += 1;
        pushFrame(view, data);
        Queue.offerUnsafe(view.frameSignals, view.frameSeq);
      },
    });
  };

  const stopScreencast = async (page: Page, view: EngineViewState) => {
    view.lastFrame = undefined;
    await page.screencast.stop().catch(() => undefined);
  };

  const frames: PlaywrightPreviewHost["Service"]["frames"] = (tabId, secret) => {
    const tab = viewTab(tabId);
    if (tab?.view === undefined || tab.view.secret !== secret) return undefined;
    const { page, view } = tab;
    return Stream.callback<Uint8Array>(
      (queue) =>
        Effect.acquireRelease(
          Effect.promise(async () => {
            view.frameSinks.add(queue);
            if (view.frameSinks.size === 1) await startScreencast(page, view);
          }),
          () =>
            Effect.promise(async () => {
              view.frameSinks.delete(queue);
              if (view.frameSinks.size === 0) await stopScreencast(page, view);
            }),
        ),
      { bufferSize: 2, strategy: "sliding" },
    );
  };

  const closeView: PlaywrightPreviewHost["Service"]["closeView"] = (tabId) => {
    const tab = viewTab(tabId);
    return tab === undefined ? Effect.void : closeTab(tab);
  };

  return PlaywrightPreviewHost.of({
    installedEngines,
    invoke,
    openView,
    navigateView,
    reloadView,
    resizeView,
    sendInput,
    frames,
    closeView,
  });
});

export const layer = Layer.effect(PlaywrightPreviewHost, make);
