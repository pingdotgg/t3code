// @effect-diagnostics nodeBuiltinImport:off - Locating an executable is a
// synchronous predicate over candidate paths; routing it through FileSystem
// would push a filesystem requirement onto every tailscale command for a
// handful of stat calls. `TailscaleExecutableProbe` is the injection point.
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";

/**
 * Absolute path that pins the tailscale CLI and bypasses discovery. Honoured
 * verbatim — a wrong value fails loudly at spawn time instead of silently
 * falling back, which is what an explicit override should do.
 */
export const TAILSCALE_CLI_PATH_ENV = "SERGECODE_TAILSCALE_CLI";

export type TailscaleExecutableSource =
  /** `SERGECODE_TAILSCALE_CLI` was set. */
  | "override"
  /** Found on the inherited `PATH`. */
  | "path"
  /** Found at a known install location that is not on `PATH`. */
  | "install-location"
  /** Nothing was found; the bare command name is used so spawn reports it. */
  | "not-found";

export interface TailscaleExecutable {
  readonly command: string;
  readonly source: TailscaleExecutableSource;
}

/**
 * Predicate used to test discovery candidates. Overridable so tests can probe
 * a fake filesystem — and so a platform's candidate list can be exercised from
 * any host.
 */
export const TailscaleExecutableProbe = Context.Reference<(candidate: string) => boolean>(
  "@t3tools/tailscale/TailscaleExecutableProbe",
  { defaultValue: () => isExecutableFile },
);

function isExecutableFile(candidate: string): boolean {
  try {
    if (!NodeFS.statSync(candidate).isFile()) {
      return false;
    }
    NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const tailscaleBinaryName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

const pathSeparator = (platform: NodeJS.Platform): string => (platform === "win32" ? ";" : ":");

const directorySeparator = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "\\" : "/";

const joinPath = (platform: NodeJS.Platform, directory: string, name: string): string => {
  const separator = directorySeparator(platform);
  const trimmed = directory.endsWith(separator) ? directory.slice(0, -1) : directory;
  return `${trimmed}${separator}${name}`;
};

const distinct = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

/**
 * Install locations to check when `tailscale` is absent from `PATH`.
 *
 * macOS is the case that matters: both the Mac App Store and the standalone
 * `.app` ship the CLI *inside the bundle* and never install a `PATH` entry for
 * it, and a GUI-launched app inherits a `PATH` that has no Homebrew prefix
 * either. Without this list, `spawn("tailscale")` fails with ENOENT on a
 * perfectly healthy Tailscale install and the tailnet endpoint is never
 * advertised — remote pairing then silently degrades to LAN-only.
 */
export const tailscaleInstallLocations = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> => {
  switch (platform) {
    case "darwin": {
      const home = env["HOME"];
      return distinct([
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ...(home ? [`${home}/Applications/Tailscale.app/Contents/MacOS/Tailscale`] : []),
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
      ]);
    }
    case "win32": {
      const programDirectories = [
        env["ProgramW6432"],
        env["ProgramFiles"],
        env["ProgramFiles(x86)"],
        "C:\\Program Files",
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      return distinct(
        programDirectories.map((directory) =>
          joinPath(platform, joinPath(platform, directory, "Tailscale"), "tailscale.exe"),
        ),
      );
    }
    default:
      return distinct([
        "/usr/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/sbin/tailscale",
        "/snap/bin/tailscale",
      ]);
  }
};

/**
 * Resolves the tailscale CLI: explicit override, then `PATH`, then the known
 * install locations. Falls back to the bare binary name so a missing CLI still
 * surfaces as the same spawn error it always did.
 */
export const resolveTailscaleExecutableWith = (input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly isExecutable: (candidate: string) => boolean;
}): TailscaleExecutable => {
  const override = input.env[TAILSCALE_CLI_PATH_ENV]?.trim();
  if (override) {
    return { command: override, source: "override" };
  }

  const name = tailscaleBinaryName(input.platform);
  const rawPath = input.env["PATH"] ?? input.env["Path"] ?? "";
  for (const entry of rawPath.split(pathSeparator(input.platform))) {
    const directory = entry.trim();
    if (directory.length === 0) {
      continue;
    }
    const candidate = joinPath(input.platform, directory, name);
    if (input.isExecutable(candidate)) {
      return { command: candidate, source: "path" };
    }
  }

  for (const candidate of tailscaleInstallLocations(input.platform, input.env)) {
    if (input.isExecutable(candidate)) {
      return { command: candidate, source: "install-location" };
    }
  }

  return { command: name, source: "not-found" };
};

export const resolveTailscaleExecutable: Effect.Effect<TailscaleExecutable> = Effect.gen(
  function* () {
    const platform = yield* HostProcessPlatform;
    const env = yield* HostProcessEnvironment;
    const isExecutable = yield* TailscaleExecutableProbe;
    return resolveTailscaleExecutableWith({ platform, env, isExecutable });
  },
);
