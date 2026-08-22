// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Windows Chromium/Electron can fatal the whole desktop process with
 * `GPU process isn't usable. Goodbye.` / exit_code=-2147483645
 * (STATUS_BREAKPOINT) when the GPU sandbox is enabled. Affected machines
 * never show a window; Task Manager only shows background helpers.
 *
 * Empirically on Windows:
 * - no flags / `--disable-gpu-sandbox` / `--in-process-gpu`: no usable window
 * - `--no-sandbox`: process stays alive and the main window shows
 *
 * See https://github.com/pingdotgg/t3code/issues/1357 and #4543.
 *
 * The Chromium process sandbox stays enabled by default so preview webviews
 * keep the OS-level containment documented in WebviewPreferences. The
 * workaround is applied only when:
 * - `T3CODE_DISABLE_CHROMIUM_SANDBOX=1` (explicit opt-in), or
 * - argv already includes `--no-sandbox`, or
 * - a previous GPU STATUS_BREAKPOINT crash wrote the recovery marker
 *
 * `installWindowsChromiumSandboxRecovery` watches for that GPU death, writes
 * the marker, and relaunches once with `--no-sandbox`.
 */
export type WindowsChromiumSandboxSwitch = "no-sandbox";

export const WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV = "T3CODE_DISABLE_CHROMIUM_SANDBOX";
export const WINDOWS_CHROMIUM_SANDBOX_SWITCH = "no-sandbox" satisfies WindowsChromiumSandboxSwitch;
/** Signed form of STATUS_BREAKPOINT (0x80000003) observed on affected Windows hosts. */
export const WINDOWS_GPU_SANDBOX_BREAKPOINT_EXIT_CODE = -2147483645;
const WINDOWS_CHROMIUM_SANDBOX_MARKER_FILE = "windows-chromium-sandbox-workaround";

export interface WindowsChromiumSandboxDecisionInput {
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: ReadonlyArray<string>;
  readonly homeDirectory?: string;
  readonly markerPath?: string;
  readonly markerExists?: (markerPath: string) => boolean;
}

export function resolveWindowsChromiumSandboxMarkerPath(
  homeDirectory = NodeOS.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredHome = env.T3CODE_HOME?.trim();
  const baseDir =
    configuredHome && configuredHome.length > 0
      ? configuredHome
      : NodePath.join(homeDirectory, ".t3");
  return NodePath.join(baseDir, "userdata", WINDOWS_CHROMIUM_SANDBOX_MARKER_FILE);
}

export function argvRequestsWindowsChromiumSandboxDisable(argv: ReadonlyArray<string>): boolean {
  // Only the Chromium switch form. A bare positional `no-sandbox` must not
  // disable process isolation just because a path/project uses that name.
  return argv.some((entry) => entry === `--${WINDOWS_CHROMIUM_SANDBOX_SWITCH}`);
}

export function shouldDisableWindowsChromiumSandbox(
  input: WindowsChromiumSandboxDecisionInput,
): boolean {
  if (input.platform !== "win32") return false;

  const env = input.env ?? process.env;
  if (env[WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV] === "1") return true;

  const argv = input.argv ?? process.argv;
  if (argvRequestsWindowsChromiumSandboxDisable(argv)) return true;

  const markerPath =
    input.markerPath ??
    resolveWindowsChromiumSandboxMarkerPath(input.homeDirectory ?? NodeOS.homedir(), env);
  const markerExists = input.markerExists ?? ((path) => NodeFS.existsSync(path));
  return markerExists(markerPath);
}

export function resolveWindowsChromiumSandboxSwitches(
  input: WindowsChromiumSandboxDecisionInput,
): ReadonlyArray<WindowsChromiumSandboxSwitch> {
  return shouldDisableWindowsChromiumSandbox(input) ? [WINDOWS_CHROMIUM_SANDBOX_SWITCH] : [];
}

export function applyWindowsChromiumSandboxSwitches(input: {
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: ReadonlyArray<string>;
  readonly homeDirectory?: string;
  readonly markerPath?: string;
  readonly markerExists?: (markerPath: string) => boolean;
  readonly appendSwitch: (switchName: WindowsChromiumSandboxSwitch) => void;
}): ReadonlyArray<WindowsChromiumSandboxSwitch> {
  const switches = resolveWindowsChromiumSandboxSwitches(input);
  for (const switchName of switches) {
    input.appendSwitch(switchName);
  }
  return switches;
}

export function writeWindowsChromiumSandboxMarker(
  markerPath: string,
  writeFile: (path: string, contents: string) => void = (path, contents) => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, contents, "utf8");
  },
): void {
  writeFile(
    markerPath,
    [
      "T3 Code enables Chromium --no-sandbox on this Windows host after a GPU",
      "STATUS_BREAKPOINT crash (GPU process isn't usable). Delete this file to",
      "retry with the Chromium sandbox enabled.",
      "",
    ].join("\n"),
  );
}

export function isWindowsGpuSandboxBreakpointCrash(details: {
  readonly type?: string;
  readonly exitCode?: number;
}): boolean {
  return details.type === "GPU" && details.exitCode === WINDOWS_GPU_SANDBOX_BREAKPOINT_EXIT_CODE;
}

export function buildWindowsChromiumSandboxRelaunchArgs(
  argv: ReadonlyArray<string>,
): Array<string> {
  const args = argv.slice(1).filter((entry) => entry !== "--");
  if (!argvRequestsWindowsChromiumSandboxDisable(args)) {
    args.push(`--${WINDOWS_CHROMIUM_SANDBOX_SWITCH}`);
  }
  return args;
}

export interface WindowsChromiumSandboxRecoveryApp {
  readonly on: (
    event: "child-process-gone",
    listener: (
      event: unknown,
      details: {
        readonly type?: string;
        readonly exitCode?: number;
      },
    ) => void,
  ) => void;
  readonly relaunch: (options: { readonly args: ReadonlyArray<string> }) => void;
  readonly exit: (code?: number) => void;
}

/**
 * When the Chromium sandbox is still enabled on Windows, watch for the known
 * GPU STATUS_BREAKPOINT failure, persist a marker, and relaunch once with
 * `--no-sandbox` so unaffected hosts keep sandbox containment by default.
 */
export function installWindowsChromiumSandboxRecovery(input: {
  readonly platform: NodeJS.Platform;
  readonly app: WindowsChromiumSandboxRecoveryApp;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: ReadonlyArray<string>;
  readonly homeDirectory?: string;
  readonly markerPath?: string;
  readonly writeMarker?: (markerPath: string) => void;
}): boolean {
  // Never register on macOS/Linux: a matching GPU exitCode there must not
  // write the Windows marker or relaunch with --no-sandbox.
  if (input.platform !== "win32") {
    return false;
  }

  if (
    shouldDisableWindowsChromiumSandbox({
      platform: input.platform,
      env: input.env,
      argv: input.argv,
      homeDirectory: input.homeDirectory,
      markerPath: input.markerPath,
    })
  ) {
    return false;
  }

  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv;
  const markerPath =
    input.markerPath ??
    resolveWindowsChromiumSandboxMarkerPath(input.homeDirectory ?? NodeOS.homedir(), env);
  const writeMarker = input.writeMarker ?? writeWindowsChromiumSandboxMarker;
  let recovering = false;

  input.app.on("child-process-gone", (_event, details) => {
    if (recovering || !isWindowsGpuSandboxBreakpointCrash(details)) return;
    recovering = true;
    try {
      writeMarker(markerPath);
    } catch {
      // Still relaunch with the switch even if the marker cannot be persisted.
    }
    input.app.relaunch({ args: buildWindowsChromiumSandboxRelaunchArgs(argv) });
    input.app.exit(0);
  });

  return true;
}
