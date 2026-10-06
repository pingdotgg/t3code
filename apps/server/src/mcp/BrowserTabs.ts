/**
 * Opt-in Chrome DevTools MCP attached to the Chromium browser the user already
 * has open, with their tabs and sign-ins. Providers launch it next to the
 * `t3-code` server; a connection is what asks the user to allow access, so
 * checking status never opens the browser's debugging port.
 */
import type { BrowserTabsAction, BrowserTabsBrowser, BrowserTabsStatus } from "@t3tools/contracts";
import { BrowserTabsError } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ensurePinnedTool, findPinnedTool, type ToolSpec } from "../device/DeviceToolchain.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const CHROME_DEVTOOLS_MCP: ToolSpec = {
  name: "chrome-devtools-mcp",
  version: "1.10.1",
  entry: ["build", "src", "bin", "chrome-devtools-mcp.js"],
};

/** A stdio MCP server a provider launches next to `t3-code`. */
export interface BrowserTabsMcpServer {
  readonly name: "chrome-devtools";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly browserName: string;
}

interface BrowserLocation {
  readonly id: string;
  readonly name: string;
  readonly scheme: string;
  /** The profile root per platform, relative to its base directory. */
  readonly darwin?: string;
  readonly linux?: string;
  readonly win32?: string;
}

/**
 * Chromium browsers Chrome DevTools MCP can attach to. macOS profiles sit under
 * ~/Library/Application Support, Linux ones under $XDG_CONFIG_HOME, and
 * Windows ones under %LOCALAPPDATA%.
 */
const BROWSERS: ReadonlyArray<BrowserLocation> = [
  {
    id: "chrome",
    name: "Google Chrome",
    scheme: "chrome",
    darwin: "Google/Chrome",
    linux: "google-chrome",
    win32: "Google/Chrome/User Data",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    scheme: "edge",
    darwin: "Microsoft Edge",
    linux: "microsoft-edge",
    win32: "Microsoft/Edge/User Data",
  },
  {
    id: "brave",
    name: "Brave",
    scheme: "brave",
    darwin: "BraveSoftware/Brave-Browser",
    linux: "BraveSoftware/Brave-Browser",
    win32: "BraveSoftware/Brave-Browser/User Data",
  },
  {
    id: "helium",
    name: "Helium",
    scheme: "helium",
    darwin: "net.imput.helium",
    linux: "net.imput.helium",
    win32: "imput/Helium/User Data",
  },
  {
    id: "chromium",
    name: "Chromium",
    scheme: "chrome",
    darwin: "Chromium",
    linux: "chromium",
    win32: "Chromium/User Data",
  },
];

interface DetectedBrowser extends BrowserTabsBrowser {
  readonly userDataDir: string;
  readonly since: number;
}

/** Installed Chromium browsers, the newest remote debugging session first. */
export const detectBrowsers = Effect.fn("BrowserTabs.detectBrowsers")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const home = environment.HOME ?? environment.USERPROFILE;
  const base =
    platform === "darwin"
      ? home && path.join(home, "Library", "Application Support")
      : platform === "linux"
        ? environment.XDG_CONFIG_HOME?.trim() || (home && path.join(home, ".config"))
        : platform === "win32"
          ? environment.LOCALAPPDATA
          : undefined;
  if (!base) return [];

  const found: Array<DetectedBrowser> = [];
  for (const browser of BROWSERS) {
    const relative =
      platform === "darwin" ? browser.darwin : platform === "linux" ? browser.linux : browser.win32;
    if (!relative) continue;
    const userDataDir = path.join(base, ...relative.split("/"));
    if (!(yield* fs.exists(userDataDir).pipe(Effect.orElseSucceed(() => false)))) continue;
    // Chromium writes this file when remote debugging starts. Its port is never
    // opened here: connecting is what asks the user to allow access.
    const portFile = path.join(userDataDir, "DevToolsActivePort");
    const port = yield* fs.readFileString(portFile).pipe(
      Effect.map((text) => Number.parseInt(text.split("\n")[0] ?? "", 10)),
      Effect.orElseSucceed(() => Number.NaN),
    );
    const remoteDebugging = Number.isInteger(port) && port > 0;
    const since = remoteDebugging
      ? yield* fs.stat(portFile).pipe(
          Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? 0),
          Effect.orElseSucceed(() => 0),
        )
      : 0;
    found.push({
      id: browser.id,
      name: browser.name,
      inspectUrl: `${browser.scheme}://inspect/#remote-debugging`,
      remoteDebugging,
      userDataDir,
      since,
    });
  }
  return found.toSorted((a, b) => b.since - a.since);
});

export class BrowserTabs extends Context.Service<
  BrowserTabs,
  {
    /** The server a session gets while the setting is on and the tool is installed. Never installs. */
    readonly server: Effect.Effect<Option.Option<BrowserTabsMcpServer>>;
    readonly status: Effect.Effect<BrowserTabsStatus>;
    readonly runAction: (
      action: BrowserTabsAction,
    ) => Effect.Effect<BrowserTabsStatus, BrowserTabsError>;
  }
>()("t3/mcp/BrowserTabs") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessEnvironment, environment),
    );
  const browsers = provide(detectBrowsers());
  const installed = provide(findPinnedTool(config.baseDir, CHROME_DEVTOOLS_MCP)).pipe(
    Effect.orElseSucceed(() => null),
  );

  const status = Effect.gen(function* () {
    return {
      browsers: (yield* browsers).map(({ id, name, inspectUrl, remoteDebugging }) => ({
        id,
        name,
        inspectUrl,
        remoteDebugging,
      })),
      toolInstalled: (yield* installed) !== null,
    } satisfies BrowserTabsStatus;
  });

  const server = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.enableAgentBrowserTabs),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return Option.none<BrowserTabsMcpServer>();
    const tool = yield* installed;
    const node = yield* provide(resolveNodeExecutable("Browser tab access")).pipe(Effect.option);
    if (tool === null || Option.isNone(node)) {
      yield* Effect.logWarning("Browser tab access is on, but Chrome DevTools MCP is not ready.");
      return Option.none<BrowserTabsMcpServer>();
    }
    // Without a browser in remote debugging mode, fall back to Chrome's profile.
    const browser = (yield* browsers).find((candidate) => candidate.remoteDebugging);
    return Option.some<BrowserTabsMcpServer>({
      name: "chrome-devtools",
      command: node.value,
      args: [
        tool.entryPath,
        "--autoConnect",
        ...(browser ? ["--userDataDir", browser.userDataDir] : []),
        "--no-usage-statistics",
        "--no-performance-crux",
      ],
      // The desktop backend is Electron, which needs this to act as Node.
      env: { ELECTRON_RUN_AS_NODE: "1" },
      browserName: browser?.name ?? "Chrome",
    });
  });

  const runAction = Effect.fn("BrowserTabs.runAction")(function* (action: BrowserTabsAction) {
    if (action === "install-tool") {
      yield* provide(
        resolveNodeExecutable("Browser tab access").pipe(
          Effect.andThen(ensurePinnedTool(config.baseDir, CHROME_DEVTOOLS_MCP)),
        ),
      ).pipe(Effect.mapError((cause) => new BrowserTabsError({ action, cause })));
    }
    return yield* status;
  });

  return BrowserTabs.of({ server, status, runAction });
});

export const layer = Layer.effect(BrowserTabs, make).pipe(Layer.provide(ProcessRunner.layer));
