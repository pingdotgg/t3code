// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Owns Playwright resources and their idle timer outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession, Cookie } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

const BADGE_STUB = `if (typeof WorkerNavigator === "function") for (const name of ["setAppBadge", "clearAppBadge"]) WorkerNavigator.prototype[name] = () => Promise.resolve();`;

interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  createChildSession(...args: ReadonlyArray<unknown>): CdpSession;
}

// The headless shell binds no BadgeService for service workers and kills the renderer of a
// worker that calls navigator.setAppBadge. Playwright resumes each worker itself, so the stub
// can only go in ahead of that resume through its in-process session; without it nothing is stubbed.
const stubWorkerBadges = (client: Browser | BrowserContext) => {
  const { _connection: connection } = client as unknown as {
    readonly _connection?: {
      readonly toImpl?: (
        client: unknown,
      ) =>
        | { readonly _session?: CdpSession; readonly _browser?: { readonly _session?: CdpSession } }
        | undefined;
    };
  };
  const impl = connection?.toImpl?.(client);
  const root = impl?._browser?._session ?? impl?._session;
  if (!root) return;
  const createChildSession = root.createChildSession.bind(root);
  root.createChildSession = (...args) => {
    const session = createChildSession(...args);
    const send = session.send.bind(session);
    session.send = (method, params) => {
      if (method === "Runtime.runIfWaitingForDebugger") {
        void send("Runtime.evaluate", { expression: BADGE_STUB }).catch(constVoid);
      }
      return send(method, params);
    };
    return session;
  };
};

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** Closes the shared browser once it holds no context, and a profile once it has no page, for this long. */
  readonly idleBrowserMs?: number;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  /** Profile clears among `clearing`, which a concurrent clear joins instead of repeating. */
  private readonly wipes = new WeakSet<Promise<void>>();
  /** Restarts an open profile's idle wait. */
  private readonly profileIdle = new Map<string, () => void>();
  /** Session cookies of idle-closed profiles, re-added on relaunch; a server restart drops them. */
  private readonly sessionCookies = new Map<string, Cookie[]>();
  private browser: Promise<Browser> | undefined;
  private sharedClosing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSharedContexts = 0;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        stubWorkerBadges(browser);
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  private async sharedContext(options?: Parameters<Browser["newContext"]>[0]) {
    clearTimeout(this.idleTimer);
    this.pendingSharedContexts++;
    const launched = this.sharedBrowser();
    try {
      const context = await (await launched).newContext(options);
      context.on("close", () => this.retireWhenIdle(launched));
      return context;
    } finally {
      this.pendingSharedContexts--;
      this.retireWhenIdle(launched);
    }
  }

  private retireWhenIdle(launched: Promise<Browser>) {
    const delay = this.options.idleBrowserMs;
    if (delay === undefined || this.closing || this.pendingSharedContexts > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.retireShared(launched), delay);
    this.idleTimer.unref();
  }

  private async retireShared(launched: Promise<Browser>) {
    const browser = await launched.catch(() => undefined);
    if (!browser || this.browser !== launched || this.pendingSharedContexts > 0) return;
    if (browser.contexts().length > 0) return;
    // Cleared first, so a request during the close launches a fresh browser.
    this.browser = undefined;
    this.sharedClosing = browser.close().catch(constVoid);
    await this.sharedClosing;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) {
      this.profileIdle.get(key)?.();
      return cached;
    }
    const persistent = isolationKey === undefined && profileId !== INCOGNITO_BROWSER_PROFILE_ID;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, persistent))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        const cookies = this.sessionCookies.get(key);
        this.sessionCookies.delete(key);
        if (cookies) await context.addCookies(cookies).catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        if (persistent) this.closeProfileWhenIdle(key, pending, context);
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private closeProfileWhenIdle(
    key: string,
    pending: Promise<BrowserContext>,
    context: BrowserContext,
  ) {
    const delay = this.options.idleBrowserMs;
    if (delay === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retireIfIdle = () => {
      if (context.pages().length > 0 || this.contexts.get(key) !== pending) return;
      void this.retireProfile(key, async () => {
        const cookies = await context.cookies().catch(() => []);
        const session = cookies.filter((cookie) => cookie.expires === -1);
        if (session.length > 0) this.sessionCookies.set(key, session);
      }).catch(constVoid);
    };
    const touch = () => {
      clearTimeout(timer);
      if (this.closing) return;
      timer = setTimeout(retireIfIdle, delay);
      timer.unref();
    };
    this.profileIdle.set(key, touch);
    context.on("page", (page) => page.on("close", touch));
    context.on("close", () => {
      clearTimeout(timer);
      if (this.profileIdle.get(key) === touch) this.profileIdle.delete(key);
    });
    touch();
  }

  private async createContext(profileId: string, persistent: boolean) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (!persistent) return this.sharedContext(contextOptions);
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    const context = await this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
    stubWorkerBadges(context);
    return context;
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await this.sharedContext();
    try {
      const page = await context.newPage();
      page.once("close", () => void context.close().catch(constVoid));
      return page;
    } catch (cause) {
      await context.close().catch(constVoid);
      throw cause;
    }
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing && this.wipes.has(existing)) return existing;
    const clearing = this.retireProfile(key, undefined, async () => {
      this.sessionCookies.delete(key);
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    });
    this.wipes.add(clearing);
    return clearing;
  }

  /** Runs `before`, closes the profile's context, then runs `after`; a reopen waits for all of it. */
  private retireProfile(key: string, before?: () => Promise<void>, after?: () => Promise<void>) {
    const previous = this.clearing.get(key)?.catch(constVoid);
    const pending = this.contexts.get(key);
    this.contexts.delete(key);
    const retiring = (async () => {
      await previous;
      const context = await pending?.catch(() => undefined);
      await before?.();
      await context?.close();
      await after?.();
    })();
    this.clearing.set(key, retiring);
    void retiring.catch(constVoid).finally(() => {
      if (this.clearing.get(key) === retiring) this.clearing.delete(key);
    });
    return retiring;
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    clearTimeout(this.idleTimer);
    await Promise.allSettled([
      ...[...this.contexts.values()].map(async (pending) => (await pending).close()),
      ...this.clearing.values(),
      this.sharedClosing,
    ]);
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
