/**
 * Opt-in stdio MCP servers that reach past T3's own browser: Cua Driver for
 * native apps, and Chrome DevTools MCP for the user's running Chromium browser.
 * Each provider launches them itself, next to the `t3-code` HTTP server. The
 * session manager records them on every thread's MCP session; only adapters
 * that can run stdio MCP servers attach them, so Codex keeps its own Computer
 * Use. macOS only for now: Windows and Linux are untested, and headless hosts have
 * nothing to drive.
 */
import {
  ServerComputerAccessError,
  type ServerComputerAccessAction,
  type ServerComputerAccessStatus,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { ensurePinnedTool, findPinnedTool, type ToolSpec } from "../device/DeviceToolchain.ts";
import { cuaControlPath, endCuaSession, ensureCuaMcpProxy } from "./CuaMcpProxy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A stdio MCP server a provider launches next to `t3-code`. */
export interface LocalMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** Prompt text that tells the agent when to use this server. */
  readonly instructions: string;
}

const CHROME_DEVTOOLS_MCP: ToolSpec = {
  name: "chrome-devtools-mcp",
  version: "1.10.1",
  entry: ["build", "src", "bin", "chrome-devtools-mcp.js"],
};

/** The installer setup runs; the version the instructions below were written for. */
const CUA_DRIVER_VERSION = "0.31.0";
const CUA_DRIVER_INSTALL_SCRIPT = "https://cua.ai/driver/install.sh";

/** System Settings panes where the user turns CuaDriver on. */
const PRIVACY_PANES = {
  "open-accessibility-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "open-screen-recording-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

const CUA_DRIVER_INSTRUCTIONS =
  "The cua-driver MCP server controls native apps on the user's computer. Use it only for work that needs an app's GUI, such as checking a native app you built. When shell commands, other MCP tools, or the t3-code preview tools can do the task, use them instead. T3 Code ends your Cua session when each turn ends; the next call starts a new one.";

const browserInstructions = (browser: { readonly name: string; readonly inspectUrl: string }) =>
  `The chrome-devtools MCP server is attached to the user's own ${browser.name}, with their open tabs and signed-in sessions. Use it only when the user asks you to work in their browser or the task needs their existing sign-ins. For other web work, use the t3-code preview tools. If it cannot connect, ask the user to turn on remote debugging at ${browser.inspectUrl}.`;

/**
 * Chromium browsers Chrome DevTools MCP can attach to, by profile folder under
 * ~/Library/Application Support. A browser counts as found when its folder exists.
 */
const BROWSERS = [
  { id: "chrome", name: "Google Chrome", scheme: "chrome", folder: "Google/Chrome" },
  { id: "helium", name: "Helium", scheme: "helium", folder: "net.imput.helium" },
  { id: "brave", name: "Brave", scheme: "brave", folder: "BraveSoftware/Brave-Browser" },
  { id: "edge", name: "Microsoft Edge", scheme: "edge", folder: "Microsoft Edge" },
  { id: "chromium", name: "Chromium", scheme: "chrome", folder: "Chromium" },
] as const;

const DEFAULT_BROWSER = { name: "Chrome", inspectUrl: "chrome://inspect/#remote-debugging" };

/** What a server without this service reports: nothing to set up. */
export const UNAVAILABLE_STATUS: ServerComputerAccessStatus = {
  cuaDriver: {
    path: null,
    permissions: { accessibility: false, screenRecording: false },
    requestingPermissions: false,
    permissionsFailed: false,
  },
  browsers: [],
  browserToolInstalled: false,
};

export interface DetectedBrowser {
  readonly id: string;
  readonly name: string;
  readonly inspectUrl: string;
  readonly userDataDir: string;
  /**
   * Whether the profile holds the DevToolsActivePort file Chromium writes when
   * remote debugging starts. The port is never opened here: a connection is
   * what asks the user to allow access.
   */
  readonly remoteDebugging: boolean;
  readonly remoteDebuggingSince: number;
}

/**
 * On macOS the installer puts the binary inside /Applications/CuaDriver.app.
 * `cua-driver mcp` run from there relaunches into that app, so macOS grants
 * Accessibility and Screen Recording to Cua Driver, not to T3 Code. GUI-launched
 * servers often lack ~/.local/bin on PATH, so it is checked by hand last.
 */
export const resolveCuaDriverPath = Effect.fn("ComputerAccess.resolveCuaDriverPath")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  const appBinary = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
  if (platform === "darwin" && (yield* exists(appBinary))) return appBinary;
  const onPath = yield* resolveCommandPath(
    platform === "win32" ? "cua-driver.exe" : "cua-driver",
  ).pipe(
    // A fresh cache finds a driver installed after the server started.
    Effect.provideService(CommandResolutionCache, new Map()),
    Effect.orElseSucceed(() => null),
  );
  if (onPath) return onPath;
  const home = (yield* HostProcessEnvironment).HOME;
  if (platform === "win32" || !home) return null;
  const userBinary = path.join(home, ".local", "bin", "cua-driver");
  return (yield* exists(userBinary)) ? userBinary : null;
});

/** Installed Chromium browsers on macOS, the newest remote debugging session first. */
export const detectBrowsers = Effect.fn("ComputerAccess.detectBrowsers")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = (yield* HostProcessEnvironment).HOME;
  if ((yield* HostProcessPlatform) !== "darwin" || !home) return [];

  const found: Array<DetectedBrowser> = [];
  for (const browser of BROWSERS) {
    const userDataDir = path.join(
      home,
      "Library",
      "Application Support",
      ...browser.folder.split("/"),
    );
    if (!(yield* fs.exists(userDataDir).pipe(Effect.orElseSucceed(() => false)))) continue;
    const portFile = path.join(userDataDir, "DevToolsActivePort");
    const port = yield* fs.readFileString(portFile).pipe(
      Effect.map((text) => Number.parseInt(text.split("\n")[0] ?? "", 10)),
      Effect.orElseSucceed(() => Number.NaN),
    );
    const remoteDebugging = Number.isInteger(port) && port > 0;
    const remoteDebuggingSince = remoteDebugging
      ? yield* fs.stat(portFile).pipe(
          Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? 0),
          Effect.orElseSucceed(() => 0),
        )
      : 0;
    found.push({
      id: browser.id,
      name: browser.name,
      inspectUrl: `${browser.scheme}://inspect/#remote-debugging`,
      userDataDir,
      remoteDebugging,
      remoteDebuggingSince,
    });
  }
  return found.toSorted((a, b) => b.remoteDebuggingSince - a.remoteDebuggingSince);
});

const CuaPermissionsJson = Schema.fromJsonString(
  Schema.Struct({
    accessibility: Schema.optional(Schema.NullOr(Schema.Boolean)),
    screen_recording: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
);
const decodeCuaPermissions = Schema.decodeEffect(CuaPermissionsJson);

export class ComputerAccess extends Context.Service<
  ComputerAccess,
  {
    /**
     * Servers the settings turn on for a thread's session. A server that is not
     * set up is left out; nothing is installed here.
     */
    readonly servers: (threadId: string) => Effect.Effect<ReadonlyArray<LocalMcpServer>>;
    /** What the setup flows show. */
    readonly status: Effect.Effect<ServerComputerAccessStatus>;
    readonly runAction: (
      action: ServerComputerAccessAction,
    ) => Effect.Effect<ServerComputerAccessStatus, ServerComputerAccessError>;
    /**
     * Ends the thread's Cua session, which removes its cursor. Called at turn
     * end, on Stop, and on errors; the next tool call starts a new session.
     */
    readonly endSession: (threadId: string) => Effect.Effect<void>;
  }
>()("t3/mcp/ComputerAccess") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const scope = yield* Scope.Scope;
  const actionLock = yield* Semaphore.make(1);
  // `cua-driver permissions grant` waits up to minutes for the user, so it
  // runs in the background while the setup dialog polls status.
  let permissionRequest: Fiber.Fiber<void> | undefined;
  let permissionRequestId = 0;
  let requestingPermissions = false;
  let permissionsFailed = false;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessEnvironment, environment),
    );

  const cuaDriver = provide(resolveCuaDriverPath());
  const browsers = provide(detectBrowsers());
  const installedChromeDevTools = provide(findPinnedTool(config.baseDir, CHROME_DEVTOOLS_MCP));

  /** Unverified grants read as false; `permissions grant` verifies them. */
  const cuaPermissions = (driverPath: string) =>
    runner.run({ command: driverPath, args: ["permissions", "status", "--json"] }).pipe(
      Effect.flatMap((result) => decodeCuaPermissions(result.stdout)),
      Effect.map((granted) => ({
        accessibility: granted.accessibility === true,
        screenRecording: granted.screen_recording === true,
      })),
      Effect.orElseSucceed(() => ({ accessibility: false, screenRecording: false })),
    );

  // Runs `cua-driver mcp` behind T3's proxy so T3 can end the session. Without
  // a Node runtime the driver runs directly and its session ends on idle.
  const cuaServer = (driverPath: string, threadId: string) =>
    provide(
      Effect.gen(function* () {
        const node = yield* resolveNodeExecutable("Computer access");
        return {
          command: node,
          args: [yield* ensureCuaMcpProxy(config.stateDir)],
          env: {
            T3_CUA_DRIVER: driverPath,
            T3_CUA_CONTROL: yield* cuaControlPath(config.stateDir, threadId),
            T3_SERVER_PID: String(process.pid),
            ELECTRON_RUN_AS_NODE: "1",
          },
        };
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Running Cua Driver without T3's session proxy.", { cause }).pipe(
          Effect.as({ command: driverPath, args: ["mcp"], env: {} }),
        ),
      ),
    );

  const servers = Effect.fn("ComputerAccess.servers")(function* (threadId: string) {
    const result: Array<LocalMcpServer> = [];
    if (platform !== "darwin") return result;
    const current = yield* settings.getSettings.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read settings; leaving computer access off.", {
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (current === null) return result;
    if (current.enableAgentComputerAccess) {
      const driverPath = yield* cuaDriver;
      if (driverPath) {
        result.push({
          name: "cua-driver",
          ...(yield* cuaServer(driverPath, threadId)),
          instructions: CUA_DRIVER_INSTRUCTIONS,
        });
      } else {
        yield* Effect.logWarning("Computer access is on, but Cua Driver is not installed.");
      }
    }
    if (current.enableAgentBrowserTabs) {
      const tool = yield* Effect.all({
        node: provide(resolveNodeExecutable("Browser tab access")),
        paths: installedChromeDevTools,
      }).pipe(
        Effect.flatMap(({ node, paths }) =>
          paths === null
            ? Effect.logWarning(
                "Browser tab access is on, but Chrome DevTools MCP is not installed.",
              ).pipe(Effect.as(null))
            : Effect.succeed({ node, entryPath: paths.entryPath }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Chrome DevTools MCP is unavailable.", { cause }).pipe(Effect.as(null)),
        ),
      );
      // Without a browser in remote debugging mode, fall back to Chrome's profile.
      const browser = (yield* browsers).find((candidate) => candidate.remoteDebugging);
      if (tool) {
        result.push({
          name: "chrome-devtools",
          // The desktop backend is Electron, which needs ELECTRON_RUN_AS_NODE
          // to act as Node; real Node ignores it.
          command: tool.node,
          args: [
            tool.entryPath,
            "--autoConnect",
            ...(browser ? ["--userDataDir", browser.userDataDir] : []),
            "--no-usage-statistics",
            "--no-performance-crux",
          ],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          instructions: browserInstructions(browser ?? DEFAULT_BROWSER),
        });
      }
    }
    return result;
  });

  const status = Effect.gen(function* () {
    if (platform !== "darwin") return UNAVAILABLE_STATUS;
    const driverPath = yield* cuaDriver;
    const permissions = driverPath
      ? yield* cuaPermissions(driverPath)
      : { accessibility: false, screenRecording: false };
    const browserToolInstalled =
      (yield* installedChromeDevTools.pipe(Effect.orElseSucceed(() => null))) !== null;
    return {
      cuaDriver: {
        path: driverPath,
        permissions,
        requestingPermissions,
        permissionsFailed,
      },
      browsers: (yield* browsers).map(({ id, name, inspectUrl, remoteDebugging }) => ({
        id,
        name,
        inspectUrl,
        remoteDebugging,
      })),
      browserToolInstalled,
    };
  });

  // The command's output stays in `cause`; users see the error's own message.
  const runChecked = (action: ServerComputerAccessAction, input: ProcessRunner.ProcessRunInput) =>
    runner.run(input).pipe(
      Effect.mapError(
        (cause) => new ServerComputerAccessError({ action, reason: "command-failed", cause }),
      ),
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.void
          : Effect.fail(
              new ServerComputerAccessError({ action, reason: "command-failed", cause: result }),
            ),
      ),
    );

  const runAction = Effect.fn("ComputerAccess.runAction")(function* (
    action: ServerComputerAccessAction,
  ) {
    if (platform !== "darwin") {
      return yield* new ServerComputerAccessError({ action, reason: "unsupported-platform" });
    }
    yield* actionLock.withPermit(
      Effect.gen(function* () {
        if (action === "install-cua-driver") {
          // Cua's official installer, pinned to the version T3 was tested with.
          // On macOS it checks the app's signature before replacing anything.
          return yield* runChecked(action, {
            command: "/bin/bash",
            args: [
              "-c",
              `set -o pipefail; curl -fsSL ${CUA_DRIVER_INSTALL_SCRIPT} | /bin/bash -s -- --no-modify-path`,
            ],
            env: { CUA_DRIVER_RS_VERSION: CUA_DRIVER_VERSION },
            timeout: "10 minutes",
          });
        }
        if (action === "install-browser-tool") {
          // Chrome DevTools MCP runs on the server's Node runtime.
          return yield* provide(
            resolveNodeExecutable("Browser tab access").pipe(
              Effect.andThen(ensurePinnedTool(config.baseDir, CHROME_DEVTOOLS_MCP)),
            ),
          ).pipe(
            Effect.mapError(
              (cause) => new ServerComputerAccessError({ action, reason: "command-failed", cause }),
            ),
            Effect.asVoid,
          );
        }
        if (
          action === "open-accessibility-settings" ||
          action === "open-screen-recording-settings"
        ) {
          return yield* runChecked(action, {
            command: "/usr/bin/open",
            args: [PRIVACY_PANES[action]],
          });
        }
        if (permissionRequest) yield* Fiber.interrupt(permissionRequest);
        permissionRequest = undefined;
        requestingPermissions = false;
        permissionsFailed = false;
        if (action === "cancel-cua-permissions") return;
        const driverPath = yield* cuaDriver;
        if (!driverPath) {
          return yield* new ServerComputerAccessError({ action, reason: "driver-missing" });
        }
        // Shows macOS's prompts for CuaDriver, then waits for both grants and
        // verifies a live capture. Its own timeouts end it within minutes.
        const id = ++permissionRequestId;
        requestingPermissions = true;
        permissionRequest = yield* runChecked(action, {
          command: driverPath,
          args: ["permissions", "grant"],
          timeout: "8 minutes",
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Cua Driver did not get both permissions.", { cause: error }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  permissionsFailed = true;
                }),
              ),
            ),
          ),
          // A newer request owns the state once it has started.
          Effect.ensuring(
            Effect.sync(() => {
              if (permissionRequestId === id) requestingPermissions = false;
            }),
          ),
          Effect.forkIn(scope),
        );
      }),
    );
    return yield* status;
  });

  const endSession = (threadId: string) =>
    provide(cuaControlPath(config.stateDir, threadId)).pipe(Effect.flatMap(endCuaSession));

  return ComputerAccess.of({ servers, status, runAction, endSession });
});

export const layer = Layer.effect(ComputerAccess, make).pipe(Layer.provide(ProcessRunner.layer));
