import { loadInternalWorker } from "../../internal/internal-worker.ts";
import type {
  InstalledBrowser,
  InstallOptions,
  Process,
} from "@puppeteer/browsers";
import {
  Browser as ChromeBrowser,
  Cache,
  CDP_WEBSOCKET_ENDPOINT_REGEX,
  detectBrowserPlatform,
  install,
  launch,
  resolveBuildId,
} from "@puppeteer/browsers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
const BrowserWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/browser/Browser.worker",
    ),
};
import * as Loopback from "../../globals/Loopback.ts";
import type * as LoopbackServer from "../../globals/LoopbackServer.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook, PluginContext } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import type { ConfigError } from "../../RuntimeError.shared.ts";
import { kVoid } from "../../workerd/Config.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type { BrowserProps } from "./BrowserOptions.shared.ts";
import {
  BINDING_BROWSER_LOOPBACK,
  BINDING_BROWSER_SESSION,
  BROWSER_SESSION_CLASS_NAME,
  BROWSER_VERSION,
  LOOPBACK_TARGET_BROWSER,
  SERVICE_BROWSER,
} from "./BrowserOptions.shared.ts";

export class Browser extends Plugin.Service<
  Browser,
  {
    /**
     * Record that a local `browser` binding is in use (so the browser service
     * is only emitted when at least one binding exists), register the
     * node-side loopback route that launches/inspects/kills Chrome, and
     * resolve the service designator the binding should target.
     */
    readonly register: (props: {
      readonly headful?: boolean;
    }) => Effect.Effect<
      WorkerdConfig.ServiceDesignator,
      ConfigError,
      PluginContext | Loopback.Loopback
    >;
  }
>()("cloudflare-runtime/plugin/Browser") {}

export const BrowserLive = Layer.effect(
  Browser,
  Effect.gen(function* () {
    // Chrome processes launched for this runtime, keyed by session id.
    // Shared node-side state — the loopback handler and the shutdown
    // finalizer both operate on it.
    const browserProcesses = new Map<string, Process>();
    let headful = false;

    // Kill any Chrome still running when the runtime shuts down.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const processes = [...browserProcesses.values()];
        browserProcesses.clear();
        await Promise.all(
          processes.map((process) => closeBrowserProcess(process)),
        );
      }),
    );

    /**
     * Node-side handler for the browser loopback route. Mirrors Miniflare's
     * `/browser/*` loopback endpoints (`workers-sdk/packages/miniflare/src/index.ts`):
     *
     * - `POST|GET /browser/launch` — download (if needed) + launch Chrome,
     *   respond with the session info.
     * - `GET /browser/status?sessionId=` — 200 while the process is alive,
     *   410 once it exited.
     * - `POST /browser/close?sessionId=` — kill the process.
     * - `GET /browser/sessionIds` — ids of all live processes.
     */
    const handler: LoopbackServer.RawHandler = async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const respond = (status: number, body?: unknown) => {
        if (body === undefined) {
          res.writeHead(status).end();
        } else {
          res
            .writeHead(status, { "content-type": "application/json" })
            .end(JSON.stringify(body));
        }
      };
      switch (url.pathname) {
        case "/browser/launch": {
          const { sessionId, browserProcess, startTime, wsEndpoint } =
            await launchBrowser({
              headful,
            });
          browserProcess.nodeProcess.on("exit", () => {
            browserProcesses.delete(sessionId);
          });
          browserProcesses.set(sessionId, browserProcess);
          return respond(200, { wsEndpoint, sessionId, startTime });
        }
        case "/browser/status": {
          const sessionId = url.searchParams.get("sessionId");
          if (sessionId === null) {
            return respond(400, { error: "Missing sessionId query parameter" });
          }
          return respond(browserProcesses.has(sessionId) ? 200 : 410);
        }
        case "/browser/close": {
          const sessionId = url.searchParams.get("sessionId");
          if (sessionId === null) {
            return respond(400, { error: "Missing sessionId query parameter" });
          }
          const browserProcess = browserProcesses.get(sessionId);
          if (!browserProcess) {
            return respond(404, { error: "Session not found" });
          }
          browserProcesses.delete(sessionId);
          // The process might already be dead; that's fine.
          await closeBrowserProcess(browserProcess);
          return respond(200);
        }
        case "/browser/sessionIds": {
          return respond(200, Array.from(browserProcesses.keys()));
        }
        default: {
          return respond(404, {
            error: `Unknown browser loopback route "${url.pathname}"`,
          });
        }
      }
    };

    return Browser.of(
      Effect.sync(() => {
        let used = false;
        let loopbackService: WorkerdConfig.ServiceDesignator | undefined;

        return {
          api: {
            register: (props: { readonly headful?: boolean }) =>
              Plugin.use(Loopback.Loopback, (loopback) =>
                Effect.map(
                  loopback.api.route(LOOPBACK_TARGET_BROWSER, handler),
                  (service) => {
                    used = true;
                    headful = headful || (props.headful ?? false);
                    loopbackService = service;
                    return { name: SERVICE_BROWSER };
                  },
                ),
              ),
          },
          defer: Effect.gen(function* () {
            if (!used || loopbackService === undefined) return {};
            const browserService: WorkerdConfig.Service = {
              name: SERVICE_BROWSER,
              worker: {
                compatibilityDate: "2025-01-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(BrowserWorker.worker),
                ),
                bindings: [
                  {
                    name: BINDING_BROWSER_LOOPBACK,
                    service: loopbackService,
                  },
                  {
                    name: BINDING_BROWSER_SESSION,
                    durableObjectNamespace: {
                      className: BROWSER_SESSION_CLASS_NAME,
                    },
                  },
                ],
                durableObjectNamespaces: [
                  {
                    className: BROWSER_SESSION_CLASS_NAME,
                    uniqueKey: `cloudflare-runtime-${BROWSER_SESSION_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                // Session state is ephemeral (each session maps to a live
                // Chrome process); mirror Miniflare's in-memory DO storage.
                durableObjectStorage: { inMemory: kVoid },
              },
            };
            return { services: [browserService] };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local Browser Rendering simulator for `alchemy dev`.
 *
 * `env.<binding>` speaks the Browser Rendering session protocol
 * (`/v1/acquire`, `/v1/sessions`, `/v1/devtools/...`) against a **real
 * headless Chrome** launched on this machine: the pinned Chrome build
 * ({@link BROWSER_VERSION}) is downloaded on first use into the shared
 * wrangler cache directory (so it is reused across projects and by
 * `wrangler dev`), and DevTools WebSocket/JSON traffic is proxied to its CDP
 * endpoint — `@cloudflare/puppeteer` works unchanged. Opt into the real,
 * remote binding with `dev: { remote: true }`.
 */
export const local = (
  props: BrowserProps,
): BindingHook<Browser | Loopback.Loopback> =>
  Plugin.use(Browser, (browser) =>
    Effect.map(
      browser.api.register({ headful: props.headful }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        service,
      }),
    ),
  );

/** Bind to the deployed Browser Rendering service via the remote bindings proxy. */
export const remote = (binding: string) =>
  makeRemoteBinding({ name: binding, type: "browser" }, (service) => ({
    name: binding,
    service,
  }));

// -----------------------------------------------------------------------------
// Chrome launch (`workers-sdk/packages/miniflare/src/plugins/browser-rendering/index.ts`)
// -----------------------------------------------------------------------------

let installedBrowser: Promise<InstalledBrowser> | undefined;

export async function launchBrowser({
  headful,
}: {
  headful?: boolean;
}): Promise<{
  sessionId: string;
  browserProcess: Process;
  startTime: number;
  wsEndpoint: string;
}> {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error("The current platform is not supported.");
  }
  const browser = ChromeBrowser.CHROME;
  const sessionId = crypto.randomUUID();

  const installOptions: InstallOptions & { unpack?: true } = {
    browser,
    platform,
    // Share wrangler's global cache so the pinned Chrome build is downloaded
    // once per machine (and reused by `wrangler dev`, which pins the same
    // version through Miniflare).
    cacheDir: getGlobalWranglerCachePath(),
    buildId: await resolveBuildId(browser, platform, BROWSER_VERSION),
    downloadProgressCallback: makeDownloadProgressLogger(),
  };

  // `@puppeteer/browsers` v3 extracts the Chrome zip with the system `unzip`
  // (or `tar.exe`/PowerShell on Windows) and falls back to its optional
  // `yauzl` peer. We depend on `yauzl` directly so the download still works in
  // minimal containers that ship no archiver binary.
  installedBrowser ??= installWithCorruptedCacheRecovery(installOptions);
  let executablePath: string;
  try {
    ({ executablePath } = await installedBrowser);
  } catch (error) {
    installedBrowser = undefined;
    throw error;
  }

  const tempUserData = NodePath.join(
    NodeOs.tmpdir(),
    "cloudflare-runtime-browser",
    `profile-${sessionId}`,
  );
  await NodeFs.promises.mkdir(tempUserData, { recursive: true });

  // https://github.com/puppeteer/puppeteer/blob/44516936ad4a878f9a89e835a9fa7b04360d6fb9/packages/puppeteer-core/src/node/ChromeLauncher.ts#L156
  const disabledFeatures = [
    "Translate",
    // AcceptCHFrame disabled because of crbug.com/1348106.
    "AcceptCHFrame",
    "MediaRouter",
    "OptimizationHints",
    "ProcessPerSiteUpToMainFrameThreshold",
    "IsolateSandboxedIframes",
  ];
  const args = [
    "--allow-pre-commit-input",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-extensions-with-background-pages",
    "--disable-crash-reporter", // No crash reporting in CfT.
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-hang-monitor",
    "--disable-infobars",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-search-engine-choice-screen",
    "--disable-sync",
    "--enable-automation",
    "--export-tagged-pdf",
    "--force-color-profile=srgb",
    "--generate-pdf-document-outline",
    "--metrics-recording-only",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    `--disable-features=${disabledFeatures.join(",")}`,
    ...(headful ? [] : ["--headless=new", "--hide-scrollbars", "--mute-audio"]),
    "--disable-extensions",
    "about:blank",
    "--remote-debugging-port=0",
    `--user-data-dir=${tempUserData}`,
  ];

  const browserProcess = launch({
    executablePath,
    args: process.env.CI ? [...args, "--no-sandbox"] : args,
    handleSIGTERM: false,
    dumpio: false,
    pipe: false,
    onExit: async () => {
      await removeDir(tempUserData).catch(() => {});
    },
  });
  let wsEndpoint: string;
  try {
    wsEndpoint = await browserProcess.waitForLineOutput(
      CDP_WEBSOCKET_ENDPOINT_REGEX,
      // Explicit timeout so the promise rejects instead of hanging forever when
      // Chrome fails to start or crashes before printing the DevTools URL. Five
      // minutes covers on-demand browser downloads on slow connections.
      5 * 60 * 1_000,
    );
    // Chrome may print the DevTools URL slightly before its listening socket is
    // fully ready to accept connections (particularly on Windows). Probe the
    // HTTP /json/version endpoint before declaring the browser ready so
    // subsequent fetches from workerd don't race the OS.
    await waitForBrowserReady(wsEndpoint);
  } catch (error) {
    // Chrome may be alive but unready (hung startup, or the CDP socket never
    // became reachable). The process was never registered in
    // `browserProcesses`, so nothing else will ever kill it — without this it
    // outlives the runtime as an orphaned process tree.
    await closeBrowserProcess(browserProcess);
    throw error;
  }
  const startTime = Date.now();
  return { sessionId, browserProcess, startTime, wsEndpoint };
}

/**
 * Close a launched Chrome, ensuring the ENTIRE process tree dies. Idempotent:
 * calling it on an already-exited process is a no-op that still resolves.
 *
 * `Process.close()` from `@puppeteer/browsers` does tree-kill on its happy
 * path (win32: `execSync("taskkill /pid <pid> /T /F")`; POSIX: SIGKILL to the
 * detached process group). But on Windows that `execSync` throws whenever
 * taskkill exits non-zero — which happens under CI load (a child in the tree
 * exiting mid-kill, or Access Denied) — and puppeteer then falls back to
 * `ChildProcess.kill()`, which on Windows terminates ONLY the root pid:
 * Chrome's renderer/GPU/utility children survive as orphans. Orphaned Chrome
 * trees accumulating across tests starved the 4-core Windows CI runner until
 * every subsequent vitest fork failed its 60s start handshake (CI run
 * 30741543083).
 *
 * So on Windows we run our own `taskkill /T /F` FIRST, while the tree root is
 * still alive (once the root pid is gone, `taskkill /T` can no longer
 * discover the children), ignoring failures, and then run puppeteer's
 * `close()` as the second kill pass + wait-for-exit. A side benefit of
 * killing before `close()`: the `onExit` profile-dir cleanup inside `close()`
 * runs after Chrome released its file locks, so the temp profile actually
 * gets deleted on Windows.
 */
export async function closeBrowserProcess(
  browserProcess: Process,
): Promise<void> {
  const nodeProcess = browserProcess.nodeProcess;
  const pid = nodeProcess.pid;
  // Guard on "our child has not exited yet" (not just pid liveness) so a
  // recycled pid can never make us taskkill an innocent process tree.
  const alive =
    pid !== undefined &&
    nodeProcess.exitCode === null &&
    nodeProcess.signalCode === null;
  if (process.platform === "win32" && alive) {
    await new Promise<void>((resolve) => {
      NodeChildProcess.execFile(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        () => resolve(),
      );
    });
  }
  // Runs the onExit hook (profile cleanup), kills if still alive (second pass
  // on Windows; the only pass on POSIX, where the process-group SIGKILL
  // reliably takes the whole tree), and resolves once the process has exited.
  await browserProcess.close().catch(() => {});
}

/**
 * Log Chrome download progress to stderr (there is no interactive spinner in
 * this runtime); logs at most once per percentage point.
 */
function makeDownloadProgressLogger(): (
  downloadedBytes: number,
  totalBytes: number,
) => void {
  let lastProgress = -1;
  return (downloadedBytes, totalBytes) => {
    const progress = Math.round((downloadedBytes / totalBytes) * 100);
    if (progress !== lastProgress && progress % 10 === 0) {
      lastProgress = progress;
      console.error(`Downloading browser... ${progress}%`);
    }
  };
}

/**
 * Regex matching the `@puppeteer/browsers` error thrown when its cache
 * directory exists but the executable inside it is missing — typically
 * because a previous `install()` was interrupted mid-extraction.
 */
const CORRUPTED_CACHE_ERROR_PATTERN =
  /The browser folder \((.+?)\) exists but the executable .+? is missing/;

/**
 * Delete a cached macOS Chrome that exists but cannot actually be executed.
 *
 * macOS 26 can stall a write partway through a signed Mach-O, leaving a
 * truncated Chrome in the cache that `install()` happily reports as already
 * installed (it only checks that the executable path exists). Probing it with
 * `--version` catches that; the caller then reinstalls into the cleared
 * directory.
 */
async function clearUnrunnableDarwinCache(
  installOptions: InstallOptions & { unpack?: true },
): Promise<void> {
  const platform = installOptions.platform;
  if (!platform) {
    throw new Error("The current platform is not supported.");
  }
  const cache = new Cache(installOptions.cacheDir);
  const executablePath = cache.computeExecutablePath(installOptions);
  try {
    await NodeFs.promises.access(executablePath, NodeFs.constants.X_OK);
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile(
        executablePath,
        ["--version"],
        { timeout: 10_000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } catch {
    await removeDir(
      cache.installationDir(
        installOptions.browser,
        platform,
        installOptions.buildId,
      ),
    );
  }
}

/**
 * Run `@puppeteer/browsers` `install()`, but if it fails with the "folder
 * exists but executable is missing" error, clear the corrupted cache
 * directory and retry once.
 */
async function installWithCorruptedCacheRecovery(
  installOptions: InstallOptions & { unpack?: true },
): Promise<InstalledBrowser> {
  if (process.platform === "darwin") {
    await clearUnrunnableDarwinCache(installOptions);
  }

  try {
    return await install(installOptions);
  } catch (e) {
    const match = (e as Error)?.message?.match(CORRUPTED_CACHE_ERROR_PATTERN);
    if (!match) {
      throw e;
    }
    const corruptedPath = match[1];
    console.error(
      `Detected corrupted Chrome cache at ${corruptedPath}; clearing and retrying.`,
    );
    try {
      await removeDir(corruptedPath);
    } catch (cleanupError) {
      throw new Error(
        `Failed to clear corrupted Chrome cache at ${corruptedPath} after detecting "${(e as Error).message}". Manual cleanup may be required.`,
        { cause: cleanupError },
      );
    }
    try {
      return await install(installOptions);
    } catch (retryError) {
      throw new Error(
        `Chrome install failed after clearing corrupted cache at ${corruptedPath}: ${(retryError as Error).message}`,
        { cause: retryError },
      );
    }
  }
}

/**
 * Probe Chrome's HTTP DevTools endpoint until it accepts connections. Without
 * this, the first request from workerd to Chrome can fail with a connection
 * refusal even though Chrome is otherwise healthy.
 */
async function waitForBrowserReady(wsEndpoint: string): Promise<void> {
  const timeoutMs = 5000;
  const initialDelayMs = 25;
  const maxDelayMs = 250;
  const perRequestTimeoutMs = 500;
  const probeUrl = `${new URL(wsEndpoint.replace("ws://", "http://")).origin}/json/version`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(probeUrl, {
        signal: AbortSignal.timeout(perRequestTimeoutMs),
      });
      // Drain the body so the connection can be reused/closed cleanly.
      await response.arrayBuffer();
      if (response.ok) {
        return;
      }
      lastError = new Error(
        `Chrome readiness probe got status ${response.status}`,
      );
    } catch (e) {
      lastError = e;
    }
    const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt++;
  }
  throw new Error(
    `Chrome readiness probe at ${probeUrl} timed out after ${timeoutMs}ms`,
    {
      cause: lastError,
    },
  );
}

const removeDir = (dir: string) =>
  NodeFs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });

/**
 * The global wrangler cache directory (`xdgAppPaths(".wrangler").cache()` in
 * `@cloudflare/workers-utils`) — a minimal, behaviour-identical port so the
 * Chrome build is shared with wrangler installs. Unlike wrangler's *config*
 * path there is no legacy `~/.wrangler` fallback.
 */
export function getGlobalWranglerCachePath(): string {
  return NodePath.join(xdgCacheDir(), ".wrangler");
}

/** XDG cache base directory (mirrors `xdg-portable`'s `cache()`). */
function xdgCacheDir(): string {
  const home = NodeOs.homedir() || NodeOs.tmpdir();
  if (process.platform === "darwin") {
    return (
      process.env.XDG_CACHE_HOME || NodePath.join(home, "Library", "Caches")
    );
  }
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || NodePath.join(home, "AppData", "Local");
    return (
      process.env.XDG_CACHE_HOME || NodePath.join(localAppData, "xdg.cache")
    );
  }
  return process.env.XDG_CACHE_HOME || NodePath.join(home, ".cache");
}
