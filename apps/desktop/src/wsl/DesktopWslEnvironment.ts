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
const RUNTIME_INSTALL_TIMEOUT = Duration.minutes(2);
const RUNTIME_PRUNE_TIMEOUT = Duration.seconds(30);
const RUNTIME_INVALIDATE_TIMEOUT = Duration.seconds(15);
const USER_HOME_TIMEOUT = Duration.seconds(5);
const TOOLCHAIN_TRANSPORT_RETRY_LIMIT = 12;
const BUILD_TRANSPORT_RETRY_LIMIT = 2;

export interface EnsureWslNodePtyOptions {
  readonly allowBuild?: boolean;
  readonly nodeEngineRange?: string | null;
}

// The packaged WSL runtime archive plus the SHA-256 identity the build recorded
// for it. The cache key derives from the same digest, and installation verifies
// the bytes before promoting the extracted tree.
export interface WslRuntimeArchive {
  readonly windowsPath: string;
  readonly runtimeId: string;
  readonly sha256: string;
}

export type PrepareWslRuntimeResult =
  | {
      readonly ok: true;
      readonly linuxAppRoot: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

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
    // Resolves the WSL distro's IPv4 address on the WSL vEthernet adapter
    // (e.g. "172.x.x.x"). The orchestrator uses this for the WSL backend's
    // httpBaseUrl so the renderer can reach it without relying on wslhost's
    // localhost→WSL automatic forwarding, which is flaky in practice
    // (the backend can be listening for 30+ seconds before wslhost starts
    // forwarding 127.0.0.1:port to WSL-side localhost).
    readonly getDistroIp: (distro: string | null) => Effect.Effect<Option.Option<string>>;
    readonly prepareRuntime: (
      distro: string | null,
      archive: WslRuntimeArchive,
    ) => Effect.Effect<PrepareWslRuntimeResult>;
    readonly pruneRuntimes: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
    // Marks a staged runtime as unusable so the next launch reinstalls it.
    readonly invalidateRuntime: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
    readonly ensureNodePty: (
      distro: string | null,
      linuxAppRoot: string,
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
  options: {
    readonly nodeEngineRange?: string | null;
    readonly resolveNode?: boolean;
  } = {},
): Effect.Effect<ShellResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const spawner = ChildProcessSpawner.ChildProcessSpawner;
  // Node probes use a login bash so profile-managed PATH entries and supported
  // version managers are available. Runtime installation needs only POSIX tools,
  // so it skips profile loading and runs sh directly.
  const resolveNode = options.resolveNode !== false;
  const command = ChildProcess.make(
    "wsl.exe",
    resolveNode
      ? [...buildDistroArgs(distro), "--", "bash", "-l", "-s"]
      : [...buildDistroArgs(distro), "--exec", "sh", "-s"],
    {
      stdin: Stream.encodeText(
        Stream.make(
          resolveNode
            ? `${buildWslNodeEnvPreamble(options.nodeEngineRange)}${bashScript}`
            : bashScript,
        ),
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

// Holds the sha256 of the runtime's server entry, written when the install
// promotes a verified tree. Presence alone only says an install once finished
// here; the digest is what lets a later launch prove the entry still is what
// that install wrote.
const WSL_RUNTIME_READY_MARKER = ".t3code-wsl-runtime-ready";
const WSL_RUNTIME_SELECTED_MARKER = ".t3code-wsl-runtime-selected";
const WSL_RUNTIME_SELECTION_GRACE_MINUTES = 5;

export const sanitizeWslRuntimeId = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, "_");

// `archiveSha256` is the digest the build recorded alongside the archive. The
// install verifies the bytes before extracting, so an archive can never be
// promoted under an identity that does not describe it.
export const buildWslRuntimeInstallScript = (
  linuxArchivePath: string,
  runtimeId: string,
  archiveSha256: string,
): string => {
  const safeRuntimeId = sanitizeWslRuntimeId(runtimeId);
  return [
    "set -eu",
    'runtime_parent="$HOME/.t3/wsl-runtime"',
    `runtime_root="$runtime_parent/${safeRuntimeId}"`,
    `ready_marker="$runtime_root/${WSL_RUNTIME_READY_MARKER}"`,
    // The native payload is the part of the tree the WSL backend actually
    // dlopens, and the only part a user can plausibly break by hand. Checking
    // node-pty's package.json alone let a runtime whose pty.node had gone
    // missing stay cache-ready forever: every launch reused it and then failed
    // the native probe, with no reinstall and no fallback. Match on the glob
    // rather than a mapped `uname -m` so this stays a presence check; the probe
    // is what decides whether the binary is the right arch and loadable.
    "node_pty_payload_present() {",
    '  for candidate in "$1"/node_modules/node-pty/prebuilds/linux-*/pty.node; do',
    '    [ -f "$candidate" ] || continue',
    '    [ -f "${candidate%/*}/t3code-wsl-node-pty.json" ] || continue',
    "    return 0",
    "  done",
    "  return 1",
    "}",
    // Hashing the server entry is the only check that can tell a working cache
    // from one whose bin.mjs was truncated or half-written: the file is still
    // there, the native probe still passes, and launch then picks a server that
    // exits before it can become ready, on every restart. Hashing the ~7MB
    // entry measures in single-digit milliseconds inside the distro, once per
    // launch, against a cold reinstall of a few hundred megabytes.
    "runtime_server_entry_digest() {",
    `  sha256sum "$1/apps/server/dist/bin.mjs" 2>/dev/null | cut -d ' ' -f 1`,
    "}",
    "runtime_is_ready() {",
    '  [ -f "$ready_marker" ] &&',
    '    [ -f "$runtime_root/apps/server/dist/bin.mjs" ] &&',
    '    [ -f "$runtime_root/node_modules/node-pty/package.json" ] &&',
    '    node_pty_payload_present "$runtime_root" &&',
    // An empty or unreadable marker is a miss, not a pass: that is what a
    // runtime installed before the marker carried a digest looks like, and one
    // reinstall is the cheapest way to make it verifiable from then on.
    `    recorded_entry_digest=$(tr -d '[:space:]' < "$ready_marker" 2>/dev/null) &&`,
    '    [ -n "$recorded_entry_digest" ] &&',
    '    [ "$recorded_entry_digest" = "$(runtime_server_entry_digest "$runtime_root")" ]',
    "}",
    'mkdir -p "$runtime_parent"',
    `runtime_lock="$runtime_parent/.${safeRuntimeId}.install.lock"`,
    "trap 'exit 1' HUP INT TERM",
    'exec 9> "$runtime_lock"',
    "flock -x 9",
    "if runtime_is_ready; then",
    `  touch "$runtime_root/${WSL_RUNTIME_SELECTED_MARKER}"`,
    `  printf 'runtimeRoot:%s\\n' "$runtime_root"`,
    "  exit 0",
    "fi",
    // Hash only on a cache miss: a warm launch already exited above, and a cold
    // install is about to read the whole archive through tar anyway. `set -eu`
    // turns a distro without sha256sum into an install failure, which falls back
    // to the mounted server tree rather than trusting unverified bytes.
    `archive_sha=$(sha256sum ${shellQuote(linuxArchivePath)} | cut -d ' ' -f 1)`,
    `if [ "$archive_sha" != ${shellQuote(archiveSha256)} ]; then`,
    `  printf 'WSL runtime archive does not match its recorded SHA-256 (expected %s, got %s)\\n' ${shellQuote(archiveSha256)} "$archive_sha" >&2`,
    "  exit 1",
    "fi",
    // A backend can still be running out of an unready tree: the probe revokes
    // the ready marker without stopping the process it just failed for, and
    // invalidation deliberately leaves the tree in place for exactly that
    // reason. Deleting it here unlinks node_modules from under a live backend,
    // which then breaks the moment it lazily loads anything it had not already
    // read. Move it aside either way, but only delete it now when nothing is
    // running from it; otherwise hand it to the pruner's scratch sweep, which
    // is what that delay is for. A process's cmdline keeps the pre-rename path,
    // so this has to be asked before the move, not after. This script arrives
    // on stdin, so it cannot match itself.
    "runtime_in_use() {",
    // No /proc means no way to tell, and guessing wrong costs a live backend
    // its runtime. Keeping the tree only costs disk until the sweep runs.
    "  [ -d /proc/1 ] || return 0",
    '  grep -qF -- "$1/" /proc/[0-9]*/cmdline 2>/dev/null',
    "}",
    'if [ -e "$runtime_root" ]; then',
    '  if runtime_in_use "$runtime_root"; then',
    "    runtime_root_in_use=1",
    "  else",
    "    runtime_root_in_use=0",
    "  fi",
    `  runtime_stale=$(mktemp -d "$runtime_parent/.${safeRuntimeId}.stale.XXXXXX")`,
    '  rmdir "$runtime_stale"',
    '  if mv -T "$runtime_root" "$runtime_stale" 2>/dev/null; then',
    '    if [ "$runtime_root_in_use" = 1 ]; then',
    // Renaming keeps the directory's old mtime, so restart the cleanup clock.
    '      touch "$runtime_stale"',
    "    else",
    '      rm -rf "$runtime_stale"',
    "    fi",
    "  fi",
    "fi",
    `runtime_tmp=$(mktemp -d "$runtime_parent/.${safeRuntimeId}.tmp.XXXXXX")`,
    'cleanup_runtime_install() { rm -rf "$runtime_tmp"; }',
    "trap cleanup_runtime_install EXIT",
    `tar -xzf ${shellQuote(linuxArchivePath)} -C "$runtime_tmp"`,
    'test -f "$runtime_tmp/apps/server/dist/bin.mjs"',
    'test -f "$runtime_tmp/node_modules/node-pty/package.json"',

    // Never write the ready marker over a tree that is missing the native
    // payload. Failing here drops out to the mounted-tree fallback, which is
    // recoverable; promoting it would mark the defect ready and cache it.
    'if ! node_pty_payload_present "$runtime_tmp"; then',
    "  printf 'WSL runtime archive is missing its Linux node-pty binary\\n' >&2",
    "  exit 1",
    "fi",
    // The archive's bytes were verified against archiveSha256 above, so the
    // digest recorded here describes content this install proved. Every later
    // warm reuse checks the entry against it.
    'installed_entry_digest=$(runtime_server_entry_digest "$runtime_tmp")',
    'if [ -z "$installed_entry_digest" ]; then',
    "  printf 'Could not hash the WSL runtime server entry\\n' >&2",
    "  exit 1",
    "fi",
    `printf '%s\\n' "$installed_entry_digest" > "$runtime_tmp/${WSL_RUNTIME_READY_MARKER}"`,
    'if mv -T "$runtime_tmp" "$runtime_root" 2>/dev/null; then',
    "  :",
    "elif runtime_is_ready; then",
    '  rm -rf "$runtime_tmp"',
    "else",
    `  printf 'Could not promote WSL runtime cache at %s\\n' "$runtime_root" >&2`,
    "  exit 1",
    "fi",
    `touch "$runtime_root/${WSL_RUNTIME_SELECTED_MARKER}"`,
    `printf 'runtimeRoot:%s\\n' "$runtime_root"`,
  ].join("\n");
};

// An interrupted install leaves a dot-prefixed scratch directory behind. A cold
// install extracts a few hundred MB inside the distro, so two hours is far past
// any live install while still bounding how long an orphan survives.
const ORPHANED_RUNTIME_SCRATCH_MAX_AGE_MINUTES = 120;

export const buildWslRuntimePruneScript = (runtimeId: string): string => {
  const safeRuntimeId = sanitizeWslRuntimeId(runtimeId);
  return [
    "set -eu",
    'runtime_parent="$HOME/.t3/wsl-runtime"',
    `current_runtime="$runtime_parent/${safeRuntimeId}"`,
    '[ -d "$runtime_parent" ] || exit 0',
    // Serialize the whole retention decision so two backends cannot select
    // different "previous" caches and delete around one another.
    'prune_lock="$runtime_parent/.prune.lock"',
    'exec 8> "$prune_lock"',
    "flock -x 8",
    // Without a way to see the distro's processes we cannot tell which caches
    // are load-bearing, and the retention rules below are not safe on their own.
    "[ -d /proc/1 ] || exit 0",
    "runtime_in_use() {",
    '  grep -qF -- "$1/" /proc/[0-9]*/cmdline 2>/dev/null',
    "}",
    'previous_runtime=""',
    'for candidate in "$runtime_parent"/sha256-*; do',
    '  [ -d "$candidate" ] || continue',
    '  [ "$candidate" != "$current_runtime" ] || continue',
    `  [ -f "$candidate/${WSL_RUNTIME_READY_MARKER}" ] || continue`,
    '  if [ -z "$previous_runtime" ] || [ "$candidate" -nt "$previous_runtime" ]; then',
    '    previous_runtime="$candidate"',
    "  fi",
    "done",
    // Only this desktop-owned prefix is eligible. Markerless roots are broken
    // caches left by invalidation and must not become permanent disk leaks.
    'for candidate in "$runtime_parent"/sha256-*; do',
    '  [ -d "$candidate" ] || continue',
    '  [ "$candidate" != "$current_runtime" ] || continue',
    '  [ "$candidate" != "$previous_runtime" ] || continue',
    '  ! runtime_in_use "$candidate" || continue',
    "  candidate_name=${candidate##*/}",
    '  candidate_lock="$runtime_parent/.${candidate_name}.install.lock"',
    '  exec 9> "$candidate_lock"',
    // A held lock means another launch is installing or repairing this cache.
    // Skip instead of waiting or deleting underneath it.
    "  flock -n 9 || continue",
    `  selected_marker="$candidate/${WSL_RUNTIME_SELECTED_MARKER}"`,
    `  if [ -f "$selected_marker" ] && find "$selected_marker" -maxdepth 0 -mmin -${String(WSL_RUNTIME_SELECTION_GRACE_MINUTES)} -print -quit | grep -q .; then`,
    "    flock -u 9",
    "    continue",
    "  fi",
    '  rm -rf -- "$candidate"',
    "  flock -u 9",
    "done",
    // Interrupted installs use dot-prefixed names under this dedicated parent.
    'for scratch in "$runtime_parent"/.*.tmp.* "$runtime_parent"/.*.stale.*; do',
    '  [ -d "$scratch" ] || continue',
    `  find "$scratch" -maxdepth 0 -mmin +${String(ORPHANED_RUNTIME_SCRATCH_MAX_AGE_MINUTES)} -print -quit | grep -q . || continue`,
    '  rm -rf -- "$scratch"',
    "done",
  ].join("\n");
};

// Drops the ready marker so the next launch reinstalls the runtime from the
// archive. Readiness is a presence check by design, so a cached tree whose
// native payload is present but unloadable (truncated pty.node, a distro whose
// glibc the binary needs and the tree was copied from another machine) stays
// ready forever and fails the probe on every launch. Only the probe can see
// that, so the probe is what revokes the marker. The tree itself is left in
// place: the install script moves an unready root aside before extracting.
export const buildWslRuntimeInvalidateScript = (runtimeId: string): string => {
  const safeRuntimeId = sanitizeWslRuntimeId(runtimeId);
  return [
    "set -eu",
    `rm -f "$HOME/.t3/wsl-runtime/${safeRuntimeId}/${WSL_RUNTIME_READY_MARKER}"`,
  ].join("\n");
};

export const parseWslRuntimeRoot = (stdout: string): string | null => {
  const prefix = "runtimeRoot:";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return null;
  const runtimeRoot = line.slice(prefix.length).replace(/\r$/, "");
  return runtimeRoot.startsWith("/") ? runtimeRoot : null;
};

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
// The WSL Node can't read inside app.asar, so confirm what the server needs is
// unpacked on the real filesystem before reporting the backend healthy. Exit 3
// marks this distinct from a node-pty prebuild problem so the caller can report
// it accurately instead of letting the server crash on ERR_MODULE_NOT_FOUND at
// launch (which, in wsl-only mode, would just fail to launch with no fallback).
//
// The sentinel must be a package the CLI bundle leaves external. It used to be
// "effect", back when the bundle externalized its runtime deps and the whole
// node_modules tree was unpacked. The bundle now inlines its JS dependencies,
// so "effect" no longer exists on disk and only the native packages do —
// resolving node-pty is what actually validates the unpacked tree.
try { require.resolve("node-pty/package.json"); } catch (_e) { process.exit(3); }
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
  linuxRepoRoot: string,
  options: EnsureWslNodePtyOptions = {},
): Effect.Effect<EnsureWslNodePtyResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
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

    // The packages the server bundle leaves external (node-pty and the other
    // native addons) couldn't be resolved on the WSL filesystem — a packaging
    // regression, since those must be unpacked from the asar. Fatal so wsl-only
    // mode falls back to Windows and dual mode surfaces the reason inline,
    // instead of the server crash-looping on ERR_MODULE_NOT_FOUND once it
    // actually launches.
    if (probe.exitCode === 3) {
      return {
        ok: false,
        reason:
          'WSL server dependencies could not be loaded (for example "node-pty"). The native packages the server needs are not unpacked where the WSL distro\'s Node can read them — this is a packaging problem with this build. Please report it.',
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

const prepareWslRuntimeImpl = Effect.fn("desktop.wsl.prepareRuntimeImpl")(function* (
  distro: string | null,
  archive: WslRuntimeArchive,
  windowsToWslPath: (
    distro: string | null,
    windowsPath: string,
  ) => Effect.Effect<Option.Option<string>>,
): Effect.fn.Return<PrepareWslRuntimeResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const linuxArchivePath = yield* windowsToWslPath(distro, archive.windowsPath);
  if (Option.isNone(linuxArchivePath)) {
    return {
      ok: false,
      reason: `wslpath conversion failed for ${archive.windowsPath}`,
    } as const;
  }

  const install = yield* runWslShell(
    distro,
    buildWslRuntimeInstallScript(linuxArchivePath.value, archive.runtimeId, archive.sha256),
    RUNTIME_INSTALL_TIMEOUT,
    { resolveNode: false },
  );
  if (install.transportFailure !== null) {
    return {
      ok: false,
      reason:
        install.transportFailure === "timeout"
          ? "WSL runtime installation timed out. Check that the distro has free disk space, then retry."
          : "WSL runtime installation lost communication with wsl.exe. Retry, or check that the distro is healthy.",
    } as const;
  }
  if (install.exitCode !== 0) {
    const trimmedTail = `${install.stdout}${install.stderr}`.trim().slice(-500);
    return {
      ok: false,
      reason: `WSL runtime installation failed (exit ${install.exitCode}): ${trimmedTail || "no stderr captured"}`,
    } as const;
  }

  const linuxAppRoot = parseWslRuntimeRoot(install.stdout);
  return linuxAppRoot === null
    ? {
        ok: false,
        reason: "WSL runtime installation completed without reporting its cache path.",
      }
    : { ok: true, linuxAppRoot };
});

const pruneWslRuntimesImpl = Effect.fn("desktop.wsl.pruneRuntimesImpl")(function* (
  distro: string | null,
  runtimeId: string,
): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runWslShell(
    distro,
    buildWslRuntimePruneScript(runtimeId),
    RUNTIME_PRUNE_TIMEOUT,
    { resolveNode: false },
  );
  if (result.transportFailure === null && result.exitCode === 0) return;

  const detail = `${result.stdout}${result.stderr}`.trim().slice(-500);
  yield* Effect.logWarning("Could not prune old WSL runtime caches.", {
    distro,
    runtimeId,
    detail: detail || `exit ${result.exitCode}`,
  });
});

const invalidateWslRuntimeImpl = Effect.fn("desktop.wsl.invalidateRuntimeImpl")(function* (
  distro: string | null,
  runtimeId: string,
): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runWslShell(
    distro,
    buildWslRuntimeInvalidateScript(runtimeId),
    RUNTIME_INVALIDATE_TIMEOUT,
    { resolveNode: false },
  );
  if (result.transportFailure === null && result.exitCode === 0) return;

  const detail = `${result.stdout}${result.stderr}`.trim().slice(-500);
  // Best effort: the caller has already fallen back to the mounted tree, so a
  // failure here only costs the reinstall that would have repaired the cache.
  yield* Effect.logWarning("Could not invalidate the staged WSL runtime cache.", {
    distro,
    runtimeId,
    detail: detail || `exit ${result.exitCode}`,
  });
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

const getDistroIpImpl = (
  distro: string | null,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // `hostname -I` prints a space-separated list of all non-loopback
      // IPs the distro has bound. The first entry on the WSL2 default
      // network is always the eth0 vEthernet address Windows can reach
      // directly (no wslhost forwarding required).
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
      if ((exitCode as unknown as number) !== 0) return Option.none<string>();
      const raw = decodeUtf8(concatChunks(stdoutBytes)).trim();
      const candidate = raw.split(/\s+/).find((part) => IPV4_PATTERN.test(part));
      return candidate ? Option.some(candidate) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(USER_HOME_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

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
  readonly getDistroIp?: (distro: string | null) => Option.Option<string>;
  readonly prepareRuntime?: (
    distro: string | null,
    archive: WslRuntimeArchive,
  ) => PrepareWslRuntimeResult;
  readonly pruneRuntimes?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
  readonly invalidateRuntime?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
  readonly ensureNodePty?: (
    distro: string | null,
    linuxAppRoot: string,
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
      getDistroIp: (distro) => Effect.succeed(stub.getDistroIp?.(distro) ?? Option.none<string>()),
      prepareRuntime: (distro, archive) =>
        Effect.succeed(
          stub.prepareRuntime?.(distro, archive) ?? {
            ok: false,
            reason: "prepareRuntime stub not configured",
          },
        ),
      pruneRuntimes: (distro, runtimeId) => stub.pruneRuntimes?.(distro, runtimeId) ?? Effect.void,
      invalidateRuntime: (distro, runtimeId) =>
        stub.invalidateRuntime?.(distro, runtimeId) ?? Effect.void,
      ensureNodePty: (distro, linuxAppRoot, options) =>
        Effect.succeed(
          stub.ensureNodePty?.(distro, linuxAppRoot, options) ?? {
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

    const getDistroIp = (distro: string | null) =>
      provideSpawner(getDistroIpImpl(distro)).pipe(Effect.withSpan("desktop.wsl.getDistroIp"));

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
      getDistroIp,
      prepareRuntime: (distro, archive) =>
        provideSpawner(prepareWslRuntimeImpl(distro, archive, windowsToWslPath)).pipe(
          Effect.withSpan("desktop.wsl.prepareRuntime"),
        ),
      pruneRuntimes: (distro, runtimeId) =>
        provideSpawner(pruneWslRuntimesImpl(distro, runtimeId)).pipe(
          Effect.withSpan("desktop.wsl.pruneRuntimes"),
        ),
      invalidateRuntime: (distro, runtimeId) =>
        provideSpawner(invalidateWslRuntimeImpl(distro, runtimeId)).pipe(
          Effect.withSpan("desktop.wsl.invalidateRuntime"),
        ),
      ensureNodePty: (distro, linuxAppRoot, options) =>
        provideSpawner(ensureNodePtyImpl(distro, linuxAppRoot, options)).pipe(
          Effect.withSpan("desktop.wsl.ensureNodePty"),
        ),
    });
  }),
);
