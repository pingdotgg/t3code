import { satisfiesSemverRange } from "@t3tools/shared/semver";

import { buildWslNodeEnvPreamble, shellQuote } from "./wslShell.ts";

const WSL_RUNTIME_READY_MARKER = ".t3code-wsl-runtime-ready";
export const WSL_RUNTIME_SELECTED_MARKER = ".t3code-wsl-runtime-selected";
export const WSL_RUNTIME_SELECTION_GRACE_MINUTES = 5;

export const sanitizeWslRuntimeId = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_");

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
    "runtime_entry_runs() {",
    '  [ -x "$1/t3" ] && "$1/t3" --version >/dev/null',
    "}",
    // Hash the entry to detect a swapped or partially written executable, even if it still runs.
    "runtime_server_entry_digest() {",
    `  sha256sum "$1/t3" 2>/dev/null | cut -d ' ' -f 1`,
    "}",
    "runtime_is_ready() {",
    '  [ -f "$ready_marker" ] &&',
    '    runtime_entry_runs "$runtime_root" 2>/dev/null &&',
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
    `archive_sha=$(sha256sum ${shellQuote(linuxArchivePath)} | cut -d ' ' -f 1)`,
    `if [ "$archive_sha" != ${shellQuote(archiveSha256)} ]; then`,
    `  printf 'WSL runtime archive does not match its recorded SHA-256 (expected %s, got %s)\\n' ${shellQuote(archiveSha256)} "$archive_sha" >&2`,
    "  exit 1",
    "fi",
    // Deletion can remove a live backend's lazy imports; check cmdline before rename preserves its old path.
    "runtime_in_use() {",
    // Without /proc, assume the runtime may still be in use.
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
    `tar -xzf ${shellQuote(linuxArchivePath)} -C "$runtime_tmp" --strip-components=1`,
    'if ! runtime_entry_runs "$runtime_tmp"; then',
    "  printf 'WSL runtime archive does not contain a working t3 executable\\n' >&2",
    "  exit 1",
    "fi",
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

// Two hours exceeds cold-install time while bounding orphan retention.
export const ORPHANED_RUNTIME_SCRATCH_MAX_AGE_MINUTES = 120;

export const buildWslRuntimePruneScript = (runtimeId: string): string => {
  const safeRuntimeId = sanitizeWslRuntimeId(runtimeId);
  return [
    "set -eu",
    'runtime_parent="$HOME/.t3/wsl-runtime"',
    `current_runtime="$runtime_parent/${safeRuntimeId}"`,
    '[ -d "$runtime_parent" ] || exit 0',
    // Serialize pruning so backends cannot select and delete different previous caches.
    'prune_lock="$runtime_parent/.prune.lock"',
    'exec 8> "$prune_lock"',
    "flock -x 8",
    // Without /proc, retention cannot distinguish caches used by live backends.
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
    'for candidate in "$runtime_parent"/sha256-*; do',
    '  [ -d "$candidate" ] || continue',
    '  [ "$candidate" != "$current_runtime" ] || continue',
    '  [ "$candidate" != "$previous_runtime" ] || continue',
    '  ! runtime_in_use "$candidate" || continue',
    "  candidate_name=${candidate##*/}",
    '  candidate_lock="$runtime_parent/.${candidate_name}.install.lock"',
    '  exec 9> "$candidate_lock"',
    "  flock -n 9 || continue",
    `  selected_marker="$candidate/${WSL_RUNTIME_SELECTED_MARKER}"`,
    `  if [ -f "$selected_marker" ] && find "$selected_marker" -maxdepth 0 -mmin -${String(WSL_RUNTIME_SELECTION_GRACE_MINUTES)} -print -quit | grep -q .; then`,
    "    flock -u 9",
    "    continue",
    "  fi",
    '  rm -rf -- "$candidate"',
    "  flock -u 9",
    "done",
    'for scratch in "$runtime_parent"/.*.tmp.* "$runtime_parent"/.*.stale.*; do',
    '  [ -d "$scratch" ] || continue',
    `  find "$scratch" -maxdepth 0 -mmin +${String(ORPHANED_RUNTIME_SCRATCH_MAX_AGE_MINUTES)} -print -quit | grep -q . || continue`,
    '  rm -rf -- "$scratch"',
    "done",
  ].join("\n");
};

// Invalidate trees that pass install checks but fail launch probes, or each launch reuses the broken cache.
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

export const NODE_PTY_BINARY_MISSING_EXIT_CODE = 4;

export const formatNodePtyProbeFailureReason = (exitCode: number): string | null =>
  exitCode === NODE_PTY_BINARY_MISSING_EXIT_CODE
    ? "WSL support is missing from this T3 Code build: the packaged Linux node-pty binary was not included. Install a build that includes WSL support."
    : null;

// Capture login-shell PATH because the server launches provider CLIs by name.
export const RESOLVED_PATH_LINE = `printf 'resolvedPath:%s\\n' "$PATH"`;

export const NODE_PTY_PROBE_SCRIPT = (
  linuxServerDir: string,
) => `printf 'nodePath:%s\\n' "$(command -v node 2>/dev/null)"
printf 'nodeVersion:%s\\n' "$(node -p 'process.versions.node' 2>/dev/null)"
${RESOLVED_PATH_LINE}
cd ${shellQuote(linuxServerDir)} && node <<'NODE' >/dev/null 2>&1
// The WSL Node can't read inside app.asar, so confirm what the server needs is
// unpacked on the real filesystem before reporting the backend healthy. Exit 3
// marks this distinct from a node-pty binary problem so the caller can report
// it accurately instead of letting the server crash on ERR_MODULE_NOT_FOUND at
// launch (which, in wsl-only mode, would just fail to launch with no fallback).
//
// The sentinel must be a package the CLI bundle leaves external. The bundle
// inlines its JS dependencies, so only the native packages exist on disk.
// Resolving node-pty is what actually validates the unpacked tree.
try { require.resolve("node-pty/package.json"); } catch (_e) { process.exit(3); }
const fs = require("node:fs");
const path = require("node:path");
const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
// node-pty 1.x is N-API based, so a single Linux pty.node is ABI-stable across
// Node versions, so require() succeeding IS the real compatibility test. Look in
// the same places node-pty's own loader does.
const candidates = [
  path.join(pkgDir, "build", "Release", "pty.node"),
  path.join(pkgDir, "prebuilds", "linux-" + process.arch, "pty.node"),
];
if (!candidates.some((candidate) => fs.existsSync(candidate))) process.exit(${NODE_PTY_BINARY_MISSING_EXIT_CODE});
require("node-pty");
NODE`;

// Resolve version-managed Node for providers without making runtime readiness depend on it.
export const buildWslRuntimeProbeScript = (linuxAppRoot: string) =>
  [
    `bash -lc ${shellQuote(`${buildWslNodeEnvPreamble()}${RESOLVED_PATH_LINE}`)} 2>/dev/null || ${RESOLVED_PATH_LINE}`,
    `${shellQuote(`${linuxAppRoot}/t3`)} --version >/dev/null 2>&1`,
  ].join("\n");

export const TOOLCHAIN_CHECK_SCRIPT = [
  "for tool in node make g++ python3; do",
  '  command -v "$tool" >/dev/null 2>&1 || echo "missing:$tool"',
  "done",
  "if command -v node >/dev/null 2>&1; then",
  `  ver="$(node -p 'process.versions.node' 2>/dev/null)"`,
  '  if [ -n "$ver" ]; then printf "nodeVersion:%s\\n" "$ver"; fi',
  "fi",
].join("\n");

export const NODE_PTY_BUILD_SCRIPT = (linuxServerDir: string) =>
  [
    "set -e",
    `cd ${shellQuote(linuxServerDir)}`,
    `pkg_dir=$(node -p "require('node:path').dirname(require.resolve('node-pty/package.json'))")`,
    `cd "$pkg_dir"`,
    "npx --yes node-gyp rebuild",
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

// Strip only Windows CR; spaces and apostrophes must survive as one env argument.
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
