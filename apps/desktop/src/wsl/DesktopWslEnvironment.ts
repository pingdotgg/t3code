import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildRemoteNodeEnvScript } from "@t3tools/ssh/tunnel";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { parseWslDistroList, type WslDistro } from "./wslPathParsing.ts";

const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const LIST_TIMEOUT = Duration.seconds(8);
const PRE_WARM_TIMEOUT = Duration.seconds(10);
const WSLPATH_TIMEOUT = Duration.seconds(10);
const PROBE_TIMEOUT = Duration.seconds(10);
const TOOLCHAIN_TIMEOUT = Duration.seconds(10);
const BUILD_TIMEOUT = Duration.minutes(5);
const USER_HOME_TIMEOUT = Duration.seconds(5);
const WSLINFO_TIMEOUT = Duration.seconds(5);
// TERM grace (6 × 0.5s) + KILL grace (4 × 0.5s) + /proc scans + wslpath;
// generous so a slow 9p mount can't turn a genuine release into "unknown".
const PATH_RELEASE_TIMEOUT = Duration.seconds(30);
const TOOLCHAIN_TRANSPORT_RETRY_LIMIT = 12;
const BUILD_TRANSPORT_RETRY_LIMIT = 2;

export interface EnsureWslNodePtyOptions {
  readonly allowBuild?: boolean;
  readonly nodeEngineRange?: string | null;
}

export type EnsureWslNodePtyResult =
  | {
      readonly ok: true;
      readonly nodePath: string;
      readonly resolvedPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly fatal: boolean;
      readonly retryLimit?: number;
    };

export class DesktopWslDistroListError extends Schema.TaggedErrorClass<DesktopWslDistroListError>()(
  "DesktopWslDistroListError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// Authoritative WSL networking mode as reported by `wslinfo
// --networking-mode` (ships with WSL on both 2.6.x and 2.7.x). "unknown"
// covers older WSL builds without wslinfo, non-standard distros, and
// transport failures — callers must treat it as "don't trust any single
// enumerated address" rather than assuming NAT.
export type WslNetworkingMode = "mirrored" | "nat" | "unknown";

// Subset of the server's PersistedServerRuntimeState (apps/server/src/
// serverRuntimeState.ts) the desktop needs to recover a reachable origin.
// Deliberately lenient: extra fields are ignored and the schema is local so
// the desktop does not import server internals across the app boundary.
const WslServerRuntimeState = Schema.Struct({
  port: Schema.Int,
  host: Schema.optional(Schema.String),
  origin: Schema.String,
});
export type WslServerRuntimeState = typeof WslServerRuntimeState.Type;
const decodeWslServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WslServerRuntimeState),
);

// Outcome of ensureWindowsPathReleased. "released" — no Linux-side process
// holds anything under the path. "busy" — processes survived SIGTERM +
// SIGKILL and still hold the path; replacing files under it from Windows
// WILL fail. "unknown" — the check could not verify (spawn failure, path
// translation failure, timeout, unparsable output). The caller only asks
// about a distro that was hosting a backend moments ago, so "unknown"
// means the distro may well be alive and holding handles: callers that
// need the path free must treat it as a failure, not a pass. (A machine
// whose WSL layer is genuinely broken recovers on the next app launch —
// preflight falls back to Windows, no WSL config enters the pool, and no
// release check runs.)
export type WslPathReleaseResult = "released" | "busy" | "unknown";

const isDesktopWslDistroListError = Schema.is(DesktopWslDistroListError);

export class DesktopWslEnvironment extends Context.Service<
  DesktopWslEnvironment,
  {
    readonly isAvailable: Effect.Effect<boolean>;
    // Best-effort enumeration for renderer UX. Backend health checks must use
    // probeDistros so a transient command failure is not mistaken for a
    // successful empty installation.
    readonly listDistros: Effect.Effect<readonly WslDistro[]>;
    readonly probeDistros: Effect.Effect<readonly WslDistro[], DesktopWslDistroListError>;
    readonly preWarm: (distro: string | null) => Effect.Effect<void>;
    readonly windowsToWslPath: (
      distro: string | null,
      windowsPath: string,
    ) => Effect.Effect<Option.Option<string>>;
    // Resolves the user's Linux home dir inside the chosen distro (e.g.
    // "/home/josh"). Used by the folder picker to expand `~` correctly.
    readonly getUserHome: (distro: string | null) => Effect.Effect<Option.Option<string>>;
    // Resolves every IPv4 address the distro has bound (from `hostname -I`),
    // in reported order. Callers must NOT treat position as meaning — the
    // ordering shifts whenever Tailscale/Docker/VPN adapters appear inside
    // the distro. Used to build the WSL backend's readiness-probe candidate
    // set next to loopback; the first candidate that answers wins.
    readonly getDistroIps: (distro: string | null) => Effect.Effect<ReadonlyArray<string>>;
    // Authoritative networking mode via `wslinfo --networking-mode`.
    readonly getNetworkingMode: (distro: string | null) => Effect.Effect<WslNetworkingMode>;
    // Reads the backend's persisted runtime state (server-runtime.json)
    // from inside the distro. Used as a readiness fallback: when every
    // probe candidate times out, the file's origin recovers the URL the
    // server actually advertises.
    readonly readServerRuntimeState: (
      distro: string | null,
      stateDir: WslServerStateDir,
    ) => Effect.Effect<Option.Option<WslServerRuntimeState>>;
    // Terminates any Linux-side process still holding files (cwd, exe, open
    // fd, or mapped file) under the given Windows path via /mnt, then
    // verifies release. Called before an update install as a defensive
    // guarantee that nothing WSL-side outlives teardown: whether 9p/DrvFs
    // handles block Windows-side replacement varies by WSL version, but a
    // surviving backend can interfere with an install either way.
    readonly ensureWindowsPathReleased: (input: {
      readonly distro: string | null;
      readonly windowsPath: string;
    }) => Effect.Effect<WslPathReleaseResult>;
    readonly ensureNodePty: (
      distro: string | null,
      windowsRepoRoot: string,
      options?: EnsureWslNodePtyOptions,
    ) => Effect.Effect<EnsureWslNodePtyResult>;
  }
>()("@t3tools/desktop/wsl/DesktopWslEnvironment") {}

const buildDistroArgs = (distro: string | null): ReadonlyArray<string> =>
  distro ? ["-d", distro] : [];

const concatChunks = (arrays: ReadonlyArray<Uint8Array>): Uint8Array => {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.byteLength;
  }
  return out;
};

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly transportFailure: "timeout" | "spawn" | "process" | null;
}

const TIMEOUT_RESULT: ShellResult = {
  exitCode: 124,
  stdout: "",
  stderr: "\n[timeout]",
  transportFailure: "timeout",
};

export const formatWslShellTransportFailureReason = (
  failure: ShellResult["transportFailure"],
): string | null => {
  switch (failure) {
    case "timeout":
      return "WSL backend preflight timed out while probing for Node.js. WSL may be slow to start; retry, or check that the distro is healthy.";
    case "spawn":
      return "WSL backend preflight could not start wsl.exe to probe for Node.js. Check that WSL is installed and the distro is accessible.";
    case "process":
      return "WSL backend preflight lost communication with wsl.exe while probing for Node.js. Retry, or check that the distro is healthy.";
    case null:
      return null;
  }
};

// Reuse the SSH remote resolver so WSL and SSH discover version-managed Node
// the same way. Passing the engine range lets the resolver fall through to
// version managers like nvm when a system node exists but is too old.
export const buildWslNodeEnvPreamble = (
  nodeEngineRange?: string | null,
): string => `${buildRemoteNodeEnvScript({ nodeEngineRange: nodeEngineRange ?? null })}
ensure_remote_node_path || true
`;

// wsl.exe re-escapes args before forwarding them to the Linux side, which
// mangles quotes inside `bash -lc "<script>"`. Pipe the script via stdin to
// avoid passing it on the command line at all.
const runWslShell = (
  distro: string | null,
  bashScript: string,
  timeout: Duration.Duration,
  options: EnsureWslNodePtyOptions = {},
): Effect.Effect<ShellResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const spawner = ChildProcessSpawner.ChildProcessSpawner;
  // -l picks up profile-managed PATH; the shared resolver covers supported
  // version managers that non-interactive login shells can miss. -s so bash
  // reads the script from stdin.
  const command = ChildProcess.make(
    "wsl.exe",
    [...buildDistroArgs(distro), "--", "bash", "-l", "-s"],
    {
      stdin: Stream.encodeText(
        Stream.make(`${buildWslNodeEnvPreamble(options.nodeEngineRange)}${bashScript}`),
      ),
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    },
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const spawnerService = yield* spawner;
      const spawnResult = yield* spawnerService.spawn(command).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure", error }) as const,
          onSuccess: (handle) => ({ _tag: "Success", handle }) as const,
        }),
      );
      if (spawnResult._tag === "Failure") {
        return {
          exitCode: 127,
          stdout: "",
          stderr: `\n${spawnResult.error.message}`,
          transportFailure: "spawn",
        } satisfies ShellResult;
      }
      const handle = spawnResult.handle;
      // Drain stdout and stderr concurrently so neither pipe buffer can fill
      // and stall the child (node-gyp rebuild emits large output on both).
      const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: exitCode as unknown as number,
        stdout: decodeUtf8(concatChunks(stdoutBytes)),
        stderr: decodeUtf8(concatChunks(stderrBytes)),
        transportFailure: null,
      } satisfies ShellResult;
    }),
  ).pipe(
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse((): ShellResult => TIMEOUT_RESULT)),
    Effect.catch((error) =>
      Effect.succeed<ShellResult>({
        exitCode: 127,
        stdout: "",
        stderr: `\n${error.message}`,
        transportFailure: "process",
      }),
    ),
  );
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const NODE_PTY_PREBUILD_MISSING_EXIT_CODE = 4;

export const formatNodePtyProbeFailureReason = (exitCode: number): string | null =>
  exitCode === NODE_PTY_PREBUILD_MISSING_EXIT_CODE
    ? "WSL support is missing from this T3 Code build: the packaged Linux node-pty binary was not included. Rebuild the Windows artifact with `--wsl-prebuild <path-to-linux-pty.node>` or install a build that includes WSL support."
    : null;

const NODE_PTY_PROBE_SCRIPT = (
  linuxServerDir: string,
) => `printf 'nodePath:%s\\n' "$(command -v node 2>/dev/null)"
printf 'nodeVersion:%s\\n' "$(node -p 'process.versions.node' 2>/dev/null)"
printf 'resolvedPath:%s\\n' "$PATH"
cd ${shellQuote(linuxServerDir)} && node <<'NODE' >/dev/null 2>&1
// The server bundle externalizes its deps to node_modules, and the WSL Node
// can't read inside app.asar, so confirm those deps are unpacked on the real
// filesystem before reporting the backend healthy. "effect" is the framework
// every server module imports; resolving it validates the whole node_modules
// tree. Exit 3 marks this distinct from a node-pty problem so the caller can
// report it accurately instead of letting the server crash on
// ERR_MODULE_NOT_FOUND at launch (which, in wsl-only mode, would just fail to
// launch with no fallback).
try { require.resolve("effect"); } catch (_e) { process.exit(3); }
const fs = require("node:fs");
const path = require("node:path");
const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
// node-pty 1.x is N-API based, so a single Linux pty.node is ABI-stable across
// Node versions — require() succeeding IS the real compatibility test. Compare
// only arch and node-pty version (a stale binary from a different node-pty),
// NOT process.versions.modules: that would reject a perfectly loadable prebuilt
// whenever the user's WSL Node ABI differs from the build's, defeating the
// whole point of shipping one prebuilt for all Node versions.
const expected = {
  arch: process.arch,
  nodePtyVersion: require("node-pty/package.json").version,
};
const prebuildDir = path.join(pkgDir, "prebuilds", "linux-" + process.arch);
const marker = path.join(prebuildDir, "t3code-wsl-node-pty.json");
const binary = path.join(prebuildDir, "pty.node");
if (!fs.existsSync(marker) || !fs.existsSync(binary)) process.exit(${NODE_PTY_PREBUILD_MISSING_EXIT_CODE});
require("node-pty");
const actual = JSON.parse(fs.readFileSync(marker, "utf8"));
for (const key of Object.keys(expected)) {
  if (actual[key] !== expected[key]) process.exit(2);
}
NODE`;

const TOOLCHAIN_CHECK_SCRIPT = [
  "for tool in node make g++ python3; do",
  '  command -v "$tool" >/dev/null 2>&1 || echo "missing:$tool"',
  "done",
  "if command -v node >/dev/null 2>&1; then",
  `  ver="$(node -p 'process.versions.node' 2>/dev/null)"`,
  '  if [ -n "$ver" ]; then printf "nodeVersion:%s\\n" "$ver"; fi',
  "fi",
].join("\n");

const NODE_PTY_BUILD_SCRIPT = (linuxServerDir: string) =>
  [
    "set -e",
    `cd ${shellQuote(linuxServerDir)}`,
    `pkg_dir=$(node -p "require('node:path').dirname(require.resolve('node-pty/package.json'))")`,
    `arch=$(node -p "process.arch")`,
    `modules=$(node -p "process.versions.modules")`,
    `node_pty_version=$(node -p "require('node-pty/package.json').version")`,
    `cd "$pkg_dir"`,
    "npx --yes node-gyp rebuild",
    `prebuild_dir="prebuilds/linux-$arch"`,
    `mkdir -p "$prebuild_dir"`,
    `cp build/Release/pty.node "$prebuild_dir/pty.node"`,
    `printf '{"arch":"%s","modules":"%s","nodePtyVersion":"%s"}\\n' "$arch" "$modules" "$node_pty_version" > "$prebuild_dir/t3code-wsl-node-pty.json"`,
    `node -e 'require("node-pty")'`,
  ].join("\n");

export interface ToolchainReport {
  readonly missingTools: ReadonlyArray<string>;
  readonly nodeVersion: string | null;
}

export const parseToolchainReport = (stdout: string): ToolchainReport => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const missingTools = lines
    .filter((line) => line.startsWith("missing:"))
    .map((line) => line.slice("missing:".length));
  const nodeVersionLine = lines.find((line) => line.startsWith("nodeVersion:"));
  const nodeVersion = nodeVersionLine
    ? nodeVersionLine.slice("nodeVersion:".length).trim() || null
    : null;
  return { missingTools, nodeVersion };
};

// Pulls the absolute node path the WSL distro resolved after the shared remote
// resolver repaired PATH. Returns null when no node was found, which the caller
// turns into an actionable "install Node" message instead of a confusing
// node-pty error.
export const parseNodePath = (stdout: string): string | null => {
  const path = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nodePath:"))
    .map((line) => line.slice("nodePath:".length).trim())
    .find((value) => value.length > 0);
  return path ?? null;
};

export const parseNodeVersion = (stdout: string): string | null => {
  const version = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nodeVersion:"))
    .map((line) => line.slice("nodeVersion:".length).trim())
    .find((value) => value.length > 0);
  return version ?? null;
};

// Captures the login-shell PATH after the shared resolver has loaded version
// managers. Preserve the value byte-for-byte apart from a Windows-style CR so
// paths containing spaces or apostrophes can be forwarded as one env argv.
export const parseResolvedPath = (stdout: string): string | null => {
  const prefix = "resolvedPath:";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return null;
  const resolvedPath = line.slice(prefix.length).replace(/\r$/, "");
  return resolvedPath.length > 0 ? resolvedPath : null;
};

export const formatMissingToolsReason = (
  report: ToolchainReport,
  requiredRange: string | null,
): string | null => {
  const nodeMissing = report.missingTools.includes("node");
  const nodeOutOfRange =
    !nodeMissing &&
    requiredRange !== null &&
    report.nodeVersion !== null &&
    !satisfiesSemverRange(report.nodeVersion, requiredRange);
  const buildToolsMissing = report.missingTools.filter((tool) => tool !== "node");

  if (!nodeMissing && !nodeOutOfRange && buildToolsMissing.length === 0) {
    return null;
  }

  const issues: string[] = [];
  const remediations: string[] = [];

  if (nodeMissing) {
    issues.push("node");
    remediations.push(
      `Node.js${requiredRange ? ` satisfying \`${requiredRange}\`` : " 18+"} (e.g. via nvm)`,
    );
  } else if (nodeOutOfRange) {
    issues.push(`node ${report.nodeVersion} (requires ${requiredRange})`);
    remediations.push(
      `a newer Node.js satisfying \`${requiredRange}\` (e.g. \`nvm install 24 && nvm alias default 24\`)`,
    );
  }

  if (buildToolsMissing.length > 0) {
    issues.push(...buildToolsMissing);
    remediations.push(
      "the build toolchain (e.g. `sudo apt install -y build-essential python3` on Ubuntu/Debian)",
    );
  }

  return `WSL distro is missing required tools: ${issues.join(", ")}. Install ${remediations.join(" and ")}, then retry.`;
};

const ensureNodePtyImpl = (
  distro: string | null,
  windowsRepoRoot: string,
  windowsToWslPath: (
    distro: string | null,
    windowsPath: string,
  ) => Effect.Effect<Option.Option<string>>,
  options: EnsureWslNodePtyOptions = {},
): Effect.Effect<EnsureWslNodePtyResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const linuxRepoRootOption = yield* windowsToWslPath(distro, windowsRepoRoot);
    if (Option.isNone(linuxRepoRootOption)) {
      return {
        ok: false,
        reason: `wslpath conversion failed for ${windowsRepoRoot}`,
        fatal: false,
      } as const;
    }
    const linuxRepoRoot = linuxRepoRootOption.value;
    // node-pty lives in the apps/server workspace's node_modules; resolve from
    // there rather than the monorepo root, where Bun's hoist layout omits it.
    const linuxServerDir = `${linuxRepoRoot}/apps/server`;

    const probe = yield* runWslShell(
      distro,
      NODE_PTY_PROBE_SCRIPT(linuxServerDir),
      PROBE_TIMEOUT,
      options,
    );
    const nodePath = parseNodePath(probe.stdout);
    const resolvedPath = parseResolvedPath(probe.stdout);

    const transportFailureReason = formatWslShellTransportFailureReason(probe.transportFailure);
    if (transportFailureReason !== null) {
      return {
        ok: false,
        reason: transportFailureReason,
        fatal: false,
      } as const;
    }

    // No node at all, even after the shared resolver repaired PATH. Surface
    // the specific, actionable toolchain message rather than a confusing
    // node-pty error, and don't try to build.
    if (nodePath === null) {
      const toolchainCheck = yield* runWslShell(
        distro,
        TOOLCHAIN_CHECK_SCRIPT,
        TOOLCHAIN_TIMEOUT,
        options,
      );
      const toolchainTransportFailure = formatWslShellTransportFailureReason(
        toolchainCheck.transportFailure,
      );
      if (toolchainTransportFailure !== null) {
        return {
          ok: false,
          reason: toolchainTransportFailure,
          fatal: false,
          retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
        } as const;
      }
      const report = parseToolchainReport(toolchainCheck.stdout);
      const reason =
        formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null) ??
        "Node.js was not found in the WSL distro. Install it (e.g. via nvm) and restart the desktop app.";
      return { ok: false, reason, fatal: true } as const;
    }

    if (resolvedPath === null) {
      return {
        ok: false,
        reason: "WSL login-shell PATH could not be resolved during backend preflight.",
        fatal: true,
      } as const;
    }

    // Server dependencies (e.g. "effect") couldn't be resolved on the WSL
    // filesystem — a packaging regression, since the server bundle needs its
    // node_modules unpacked from the asar. Fatal so wsl-only mode falls back to
    // Windows and dual mode surfaces the reason inline, instead of the server
    // crash-looping on ERR_MODULE_NOT_FOUND once it actually launches.
    if (probe.exitCode === 3) {
      return {
        ok: false,
        reason:
          "WSL server dependencies could not be loaded (for example \"effect\"). The server's bundled node_modules is not readable by the WSL distro's Node — this is a packaging problem with this build. Please report it.",
        fatal: true,
      } as const;
    }

    if (probe.exitCode === 0) {
      const rawVersion = parseNodeVersion(probe.stdout);
      if (
        rawVersion !== null &&
        options.nodeEngineRange &&
        !satisfiesSemverRange(rawVersion, options.nodeEngineRange.trim())
      ) {
        const range = options.nodeEngineRange.trim();
        return {
          ok: false,
          reason: `WSL Node.js ${rawVersion} does not satisfy the server's required engine range (${range}). Install a compatible version, and restart the desktop app.`,
          fatal: true,
        } as const;
      }
      return { ok: true, nodePath, resolvedPath } as const;
    }

    if (options.allowBuild !== true) {
      const packagedProbeFailure = formatNodePtyProbeFailureReason(probe.exitCode);
      if (packagedProbeFailure !== null) {
        return {
          ok: false,
          reason: packagedProbeFailure,
          fatal: true,
        } as const;
      }
    }

    // node is present but node-pty's native module didn't load.
    const toolchainCheck = yield* runWslShell(
      distro,
      TOOLCHAIN_CHECK_SCRIPT,
      TOOLCHAIN_TIMEOUT,
      options,
    );
    const toolchainTransportFailure = formatWslShellTransportFailureReason(
      toolchainCheck.transportFailure,
    );
    if (toolchainTransportFailure !== null) {
      return {
        ok: false,
        reason: toolchainTransportFailure,
        fatal: false,
        retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
      } as const;
    }
    const report = parseToolchainReport(toolchainCheck.stdout);

    if (options.allowBuild !== true) {
      // Packaged builds ship a prebuilt Linux node-pty, so no compiler, node-gyp,
      // or network is needed — and we must not nag the user to install build
      // tools they don't need. Still surface a missing/too-old Node (both the
      // prebuilt and the server require a compatible Node); otherwise reaching
      // here means the bundled binary itself couldn't load, which is almost
      // always an unsupported CPU architecture or incompatible system libraries.
      const nodeOnlyReason = formatMissingToolsReason(
        {
          missingTools: report.missingTools.filter((tool) => tool === "node"),
          nodeVersion: report.nodeVersion,
        },
        options.nodeEngineRange?.trim() || null,
      );
      return {
        ok: false,
        reason:
          nodeOnlyReason ??
          "The bundled WSL backend binary (node-pty) could not be loaded in this distro. This usually means an unsupported CPU architecture or incompatible system libraries (glibc). Use a glibc-based x64/arm64 WSL distro such as Ubuntu; if you already are, please report this with your distro and the output of `uname -m`.",
        fatal: true,
      } as const;
    }

    // Dev only: no prebuilt is bundled in a checkout, so compile node-pty from
    // source. Run the toolchain check first so a missing compiler or out-of-range
    // Node surfaces a specific, actionable message instead of an opaque node-gyp
    // failure. Developers have the toolchain; end users never reach this path.
    const missingReason = formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null);
    if (missingReason !== null) {
      return { ok: false, reason: missingReason, fatal: true } as const;
    }

    const build = yield* runWslShell(
      distro,
      NODE_PTY_BUILD_SCRIPT(linuxServerDir),
      BUILD_TIMEOUT,
      options,
    );
    const buildTransportFailure = formatWslShellTransportFailureReason(build.transportFailure);
    if (buildTransportFailure !== null) {
      return {
        ok: false,
        reason: buildTransportFailure,
        fatal: false,
        retryLimit: BUILD_TRANSPORT_RETRY_LIMIT,
      } as const;
    }
    if (build.exitCode === 0) return { ok: true, nodePath, resolvedPath } as const;
    const trimmedTail = `${build.stdout}${build.stderr}`.trim().slice(-500);
    return {
      ok: false,
      reason: `node-pty Linux build failed (exit ${build.exitCode}): ${trimmedTail || "no stderr captured"}`,
      fatal: true,
    } as const;
  });

export const probeWslDistros: Effect.Effect<
  readonly WslDistro[],
  DesktopWslDistroListError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("wsl.exe", ["--list", "--verbose"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    });
    const handle = yield* spawner.spawn(command);
    const stdoutBytes = yield* Stream.runCollect(handle.stdout);
    const exitCode = yield* handle.exitCode;
    if ((exitCode as unknown as number) !== 0) {
      return yield* new DesktopWslDistroListError({
        reason: `wsl.exe --list --verbose exited with code ${String(exitCode)}`,
      });
    }
    return parseWslDistroList(Buffer.from(concatChunks(stdoutBytes)));
  }),
).pipe(
  Effect.mapError((error) =>
    isDesktopWslDistroListError(error)
      ? error
      : new DesktopWslDistroListError({
          reason: `Failed to run wsl.exe --list --verbose: ${error.message}`,
        }),
  ),
  Effect.timeoutOption(LIST_TIMEOUT),
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new DesktopWslDistroListError({
          reason: "wsl.exe --list --verbose timed out",
        }),
      onSome: Effect.succeed,
    }),
  ),
);

const preWarmImpl = (
  distro: string | null,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make("wsl.exe", [...buildDistroArgs(distro), "--", "true"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: PROCESS_TERMINATE_GRACE,
      });
      const handle = yield* spawner.spawn(command);
      yield* handle.exitCode;
    }),
  ).pipe(
    Effect.timeoutOption(PRE_WARM_TIMEOUT),
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

const windowsToWslPathImpl = (
  distro: string | null,
  windowsPath: string,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> => {
  // wsl.exe interprets backslashes as escape chars; normalize to forward slashes.
  const normalized = windowsPath.replaceAll("\\", "/");
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "wslpath", "-u", normalized],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return Option.none<string>();
      const converted = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return converted.length > 0 ? Option.some(converted) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(WSLPATH_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export const getDistroIpsImpl = (
  distro: string | null,
): Effect.Effect<ReadonlyArray<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // `hostname -I` prints a space-separated list of all non-loopback IPs
      // the distro has bound. The ordering is NOT a contract: Tailscale,
      // docker0, WireGuard and friends inject addresses at arbitrary
      // positions (a WSL-side tailscaled puts a CGNAT 100.64/10 address
      // first). Return every IPv4 and let the caller probe candidates
      // instead of trusting position.
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "sh", "-c", "hostname -I"],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return [] as ReadonlyArray<string>;
      const raw = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return raw.split(/\s+/).filter((part) => IPV4_PATTERN.test(part));
    }),
  ).pipe(
    Effect.timeoutOption(USER_HOME_TIMEOUT),
    Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

export const getNetworkingModeImpl = (
  distro: string | null,
): Effect.Effect<WslNetworkingMode, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // wslinfo ships with WSL (verified on 2.6.3.0 and 2.7.3.0) and is the
      // first-party answer for the networking mode; parsing `hostname -I`
      // ordering to infer mirrored networking is what broke Tailscale-in-WSL
      // hosts. A missing wslinfo (older WSL) lands in the "unknown" branch.
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "wslinfo", "--networking-mode"],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return "unknown" as WslNetworkingMode;
      const raw = decodeUtf8(concatChunks(stdoutBytes)).trim().toLowerCase();
      if (raw === "mirrored") return "mirrored" as WslNetworkingMode;
      if (raw === "nat") return "nat" as WslNetworkingMode;
      return "unknown" as WslNetworkingMode;
    }),
  ).pipe(
    Effect.timeoutOption(WSLINFO_TIMEOUT),
    Effect.map(Option.getOrElse((): WslNetworkingMode => "unknown")),
    Effect.orElseSucceed((): WslNetworkingMode => "unknown"),
  );

// State-dir flavor mirroring the server's deriveServerPaths: backends
// launched with --dev-url resolve state under ~/.t3/dev, packaged ones
// under ~/.t3/userdata. The caller says which one the backend it spawned
// uses — reading "whichever exists" would return a stale packaged file on
// machines that have run both.
export type WslServerStateDir = "userdata" | "dev";

// The backend runs with the distro user's own $HOME (the bootstrap omits
// t3Home so Linux state never lands on /mnt/c).
const readServerRuntimeStateScript = (stateDir: WslServerStateDir): string =>
  `cat "$HOME/.t3/${stateDir}/server-runtime.json" 2>/dev/null || true`;

export const readServerRuntimeStateImpl = (
  distro: string | null,
  stateDir: WslServerStateDir,
): Effect.Effect<
  Option.Option<WslServerRuntimeState>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "sh", "-c", readServerRuntimeStateScript(stateDir)],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      yield* handle.exitCode;
      const raw = decodeUtf8(concatChunks(stdoutBytes)).trim();
      if (raw.length === 0) return Option.none<WslServerRuntimeState>();
      return yield* decodeWslServerRuntimeState(raw).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none<WslServerRuntimeState>()),
      );
    }),
  ).pipe(
    Effect.timeoutOption(WSLINFO_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<WslServerRuntimeState>()),
  );

// Finds every Linux process holding the target directory via cwd, exe, an
// open fd, or a mapped file; SIGTERMs, then SIGKILLs stragglers, then
// reports. `cd /` first so the probe shell itself (spawned with the
// desktop's install-dir cwd mapped through /mnt) never counts as a holder.
// Matching is anchored: descendants must match "$dir/" and the directory
// itself must match as an exact readlink line — a bare substring match
// would classify /mnt/c/application as a holder of /mnt/c/app and kill
// unrelated processes.
export const buildEnsurePathReleasedScript = (quotedLinuxPath: string): string => `cd /
dir=${quotedLinuxPath}
self=$$
find_holders() {
  for p in /proc/[0-9]*; do
    pid=\${p#/proc/}
    [ "$pid" = "$self" ] && continue
    [ "$pid" = "1" ] && continue
    if { readlink "$p/cwd" "$p/exe" "$p"/fd/* 2>/dev/null; cat "$p/maps" 2>/dev/null; } 2>/dev/null | grep -qF "$dir/" ||
      readlink "$p/cwd" "$p/exe" "$p"/fd/* 2>/dev/null | grep -qxF "$dir"; then
      printf '%s ' "$pid"
    fi
  done
}
holders=$(find_holders)
[ -z "$holders" ] && { echo RELEASED; exit 0; }
kill $holders 2>/dev/null
for i in 1 2 3 4 5 6; do
  sleep 0.5
  holders=$(find_holders)
  [ -z "$holders" ] && { echo RELEASED; exit 0; }
done
kill -9 $holders 2>/dev/null
for i in 1 2 3 4; do
  sleep 0.5
  holders=$(find_holders)
  [ -z "$holders" ] && { echo RELEASED; exit 0; }
done
echo "BUSY $holders"
exit 1
`;

export const ensureWindowsPathReleasedImpl = (input: {
  readonly distro: string | null;
  readonly windowsPath: string;
}): Effect.Effect<WslPathReleaseResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    // The caller only asks about a distro that was running a backend moments
    // ago, so a failed path translation means "distro reachable but the
    // check can't run" — unverifiable ("unknown"), not "no VM" — and the
    // caller must not treat it as a pass.
    const linuxPath = yield* windowsToWslPathImpl(input.distro, input.windowsPath);
    if (Option.isNone(linuxPath)) {
      return "unknown" as WslPathReleaseResult;
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Run the probe as root (-u root; WSL grants this with no password,
        // gated by the Windows host). find_holders reads /proc/<pid>/{cwd,exe,
        // fd,maps}, which the kernel exposes only to the process owner and
        // root: as the unprivileged distro user the scan gets EACCES for any
        // process it does not own, so a root- or other-user-owned holder of
        // the install dir is invisible and the check wrongly reports RELEASED.
        // Running as root lets the scan SEE every holder and lets its kills
        // land on holders it does not own. find_holders is already scoped to
        // processes that actually reference the install dir, so this cannot
        // reach unrelated processes.
        // Script goes via stdin: wsl.exe re-escapes command-line args on the
        // way into Linux, which mangles quoted paths with spaces.
        const command = ChildProcess.make(
          "wsl.exe",
          [...buildDistroArgs(input.distro), "-u", "root", "--", "sh"],
          {
            stdin: Stream.encodeText(
              Stream.make(buildEnsurePathReleasedScript(shellQuote(linuxPath.value))),
            ),
            stdout: "pipe",
            stderr: "ignore",
            killSignal: "SIGTERM",
            forceKillAfter: PROCESS_TERMINATE_GRACE,
          },
        );
        // A spawn failure here is NOT evidence that WSL is gone: wslpath just
        // succeeded against this distro, so the VM was reachable moments
        // ago. Fall through to "unknown" (via the catch below) and let the
        // caller abort.
        const handle = yield* spawner.spawn(command);
        const stdoutBytes = yield* Stream.runCollect(handle.stdout);
        const exitCode = yield* handle.exitCode;
        const raw = decodeUtf8(concatChunks(stdoutBytes)).trim();
        if ((exitCode as unknown as number) === 0 && raw.includes("RELEASED")) {
          return "released" as WslPathReleaseResult;
        }
        if (raw.includes("BUSY")) {
          return "busy" as WslPathReleaseResult;
        }
        return "unknown" as WslPathReleaseResult;
      }),
    ).pipe(
      Effect.timeoutOption(PATH_RELEASE_TIMEOUT),
      Effect.map(Option.getOrElse((): WslPathReleaseResult => "unknown")),
      Effect.orElseSucceed((): WslPathReleaseResult => "unknown"),
    );
  });

const getUserHomeImpl = (
  distro: string | null,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        // printf so there's no trailing newline noise; getent so we get the
        // real home from /etc/passwd even if $HOME is unset for some reason.
        [
          ...buildDistroArgs(distro),
          "--",
          "sh",
          "-c",
          'printf "%s" "$(getent passwd "$(id -un)" | cut -d: -f6)"',
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) return Option.none<string>();
      const home = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return home.startsWith("/") ? Option.some(home) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(USER_HOME_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

const makeIsAvailable = (
  platform: NodeJS.Platform,
  windir: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (platform !== "win32") return false;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const wslExePath = path.join(windir, "System32", "wsl.exe");
    return yield* fileSystem.exists(wslExePath).pipe(Effect.orElseSucceed(() => false));
  });

export interface DesktopWslEnvironmentTestStub {
  readonly isAvailable?: boolean;
  readonly distros?: ReadonlyArray<WslDistro>;
  readonly distroListError?: DesktopWslDistroListError;
  readonly windowsToWslPath?: (distro: string | null, windowsPath: string) => Option.Option<string>;
  readonly getUserHome?: (distro: string | null) => Option.Option<string>;
  readonly getDistroIps?: (distro: string | null) => ReadonlyArray<string>;
  readonly getNetworkingMode?: (distro: string | null) => WslNetworkingMode;
  readonly readServerRuntimeState?: (
    distro: string | null,
    stateDir: WslServerStateDir,
  ) => Option.Option<WslServerRuntimeState>;
  readonly ensureWindowsPathReleased?: (input: {
    readonly distro: string | null;
    readonly windowsPath: string;
  }) => WslPathReleaseResult;
  readonly ensureNodePty?: (
    distro: string | null,
    windowsRepoRoot: string,
    options?: EnsureWslNodePtyOptions,
  ) => EnsureWslNodePtyResult;
}

export const layerTest = (stub: DesktopWslEnvironmentTestStub = {}) => {
  const probeDistros = stub.distroListError
    ? Effect.fail(stub.distroListError)
    : Effect.succeed(stub.distros ?? []);
  return Layer.succeed(
    DesktopWslEnvironment,
    DesktopWslEnvironment.of({
      isAvailable: Effect.succeed(stub.isAvailable ?? false),
      listDistros: probeDistros.pipe(Effect.orElseSucceed(() => [])),
      probeDistros,
      preWarm: () => Effect.void,
      windowsToWslPath: (distro, windowsPath) =>
        Effect.succeed(stub.windowsToWslPath?.(distro, windowsPath) ?? Option.none()),
      getUserHome: (distro) => Effect.succeed(stub.getUserHome?.(distro) ?? Option.none<string>()),
      getDistroIps: (distro) => Effect.succeed(stub.getDistroIps?.(distro) ?? []),
      getNetworkingMode: (distro) => Effect.succeed(stub.getNetworkingMode?.(distro) ?? "unknown"),
      readServerRuntimeState: (distro, stateDir) =>
        Effect.succeed(stub.readServerRuntimeState?.(distro, stateDir) ?? Option.none()),
      ensureWindowsPathReleased: (input) =>
        Effect.succeed(stub.ensureWindowsPathReleased?.(input) ?? "unknown"),
      ensureNodePty: (distro, windowsRepoRoot, options) =>
        Effect.succeed(
          stub.ensureNodePty?.(distro, windowsRepoRoot, options) ?? {
            ok: false,
            reason: "ensureNodePty stub not configured",
            fatal: true,
          },
        ),
    }),
  );
};

export const layer = Layer.effect(
  DesktopWslEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const windir = process.env.WINDIR ?? "C:\\Windows";

    const provideSpawner = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ): Effect.Effect<A, E> =>
      effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    // Probe wsl.exe once at layer init and cache the result, exposing
    // `isAvailable` as a resolved value rather than a re-running effect.
    // WSL availability is effectively static for the process lifetime — the
    // Windows feature isn't added/removed mid-session, and backend mode
    // changes already require an app restart — so the cached boolean stays
    // accurate. Crucially this keeps `isAvailable` synchronously resolvable:
    // it's read inside the sync IPC handler getLocalEnvironmentBootstraps
    // (via the primary instance's lazy label -> resolvePrimaryLabel ->
    // describePrimary). The underlying probe does a filesystem `exists`
    // check, so leaving it as a live effect would make Effect.runSync throw
    // there and break the renderer's synchronous bootstrap path.
    const wslAvailable = yield* makeIsAvailable(environment.platform, windir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, environment.path),
      Effect.withSpan("desktop.wsl.isAvailable"),
    );
    const isAvailable = Effect.succeed(wslAvailable);

    const windowsToWslPath = (distro: string | null, windowsPath: string) =>
      provideSpawner(windowsToWslPathImpl(distro, windowsPath)).pipe(
        Effect.withSpan("desktop.wsl.windowsToWslPath"),
      );

    // Cache user-home results per distro key — folder picker can be opened
    // many times in a session and the value is stable for the life of the
    // distro. Negative results aren't cached so a transient wsl.exe failure
    // doesn't permanently disable tilde expansion.
    const userHomeCache = new Map<string, string>();
    const getUserHome = (distro: string | null) =>
      Effect.gen(function* () {
        const key = distro ?? "__default__";
        const cached = userHomeCache.get(key);
        if (cached !== undefined) return Option.some(cached);
        const resolved = yield* provideSpawner(getUserHomeImpl(distro));
        if (Option.isSome(resolved)) userHomeCache.set(key, resolved.value);
        return resolved;
      }).pipe(Effect.withSpan("desktop.wsl.getUserHome"));

    const getDistroIps = (distro: string | null) =>
      provideSpawner(getDistroIpsImpl(distro)).pipe(Effect.withSpan("desktop.wsl.getDistroIps"));

    const getNetworkingMode = (distro: string | null) =>
      provideSpawner(getNetworkingModeImpl(distro)).pipe(
        Effect.withSpan("desktop.wsl.getNetworkingMode"),
      );

    const readServerRuntimeState = (distro: string | null, stateDir: WslServerStateDir) =>
      provideSpawner(readServerRuntimeStateImpl(distro, stateDir)).pipe(
        Effect.withSpan("desktop.wsl.readServerRuntimeState"),
      );

    const ensureWindowsPathReleased = (input: {
      readonly distro: string | null;
      readonly windowsPath: string;
    }) =>
      provideSpawner(ensureWindowsPathReleasedImpl(input)).pipe(
        Effect.withSpan("desktop.wsl.ensureWindowsPathReleased"),
      );

    const probeDistros = provideSpawner(probeWslDistros).pipe(
      Effect.withSpan("desktop.wsl.probeDistros"),
    );

    return DesktopWslEnvironment.of({
      isAvailable,
      listDistros: probeDistros.pipe(
        Effect.orElseSucceed(() => []),
        Effect.withSpan("desktop.wsl.listDistros"),
      ),
      probeDistros,
      preWarm: (distro) =>
        provideSpawner(preWarmImpl(distro)).pipe(Effect.withSpan("desktop.wsl.preWarm")),
      windowsToWslPath,
      getUserHome,
      getDistroIps,
      getNetworkingMode,
      readServerRuntimeState,
      ensureWindowsPathReleased,
      ensureNodePty: (distro, windowsRepoRoot, options) =>
        provideSpawner(ensureNodePtyImpl(distro, windowsRepoRoot, windowsToWslPath, options)).pipe(
          Effect.withSpan("desktop.wsl.ensureNodePty"),
        ),
    });
  }),
);
