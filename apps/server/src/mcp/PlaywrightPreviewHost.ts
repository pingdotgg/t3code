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
  PreviewTabId,
  type PreviewBrowserEngine,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import playwrightPackage from "playwright-core/package.json" with { type: "json" };

export interface PlaywrightPreviewInvokeInput {
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export class PlaywrightPreviewHost extends Context.Service<
  PlaywrightPreviewHost,
  {
    readonly installedEngines: Effect.Effect<ReadonlyArray<PreviewBrowserEngine>>;
    readonly invoke: <A = unknown>(
      input: PlaywrightPreviewInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
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
    return `${input.target.protocol ?? "http"}://localhost:${input.target.port}${input.target.path ?? ""}`;
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

interface EngineTab {
  readonly tabId: PreviewTabId;
  readonly engine: PreviewBrowserEngine;
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

export const make = Effect.gen(function* PlaywrightPreviewHostMake() {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const tabs = new Map<PreviewTabId, EngineTab>();
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
      Array.from(tabs.values()).filter((tab) => now - tab.lastUsedAt > IDLE_CLOSE_MS),
      closeTab,
      { discard: true },
    );
  });
  yield* Effect.forkScoped(closeIdleTabs.pipe(Effect.delay(IDLE_CLOSE_MS), Effect.forever));

  const openTab = Effect.fn("PlaywrightPreviewHost.openTab")(function* (
    engine: PreviewBrowserEngine,
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
        const browser = await ENGINES[engine].browserType.launch({
          executablePath: path,
          headless: true,
        });
        const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
        return { browser, page };
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
      engine,
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

  const openOrReuseTab = (input: PreviewAutomationOpenInput) => {
    const engine = input.engine ?? "blink";
    const current =
      input.reuseExistingTab === false
        ? undefined
        : Array.from(tabs.values()).find((tab) => tab.engine === engine);
    return current === undefined ? openTab(engine) : Effect.succeed(current);
  };

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
        });
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
    const existing = input.tabId === undefined ? undefined : tabs.get(input.tabId);
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
        ? yield* openOrReuseTab(input.input as PreviewAutomationOpenInput)
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

  return PlaywrightPreviewHost.of({ installedEngines, invoke });
});

export const layer = Layer.effect(PlaywrightPreviewHost, make);
