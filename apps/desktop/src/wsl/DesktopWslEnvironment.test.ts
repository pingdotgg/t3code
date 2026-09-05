// @effect-diagnostics nodeBuiltinImport:off - the executed suite runs the generated install script through a real POSIX shell.
import { describe, it } from "@effect/vitest";
import { afterAll, expect } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildWslNodeEnvPreamble,
  buildWslRuntimeInstallScript,
  buildWslRuntimeInvalidateScript,
  buildWslRuntimePruneScript,
  DesktopWslDistroListError,
  formatMissingToolsReason,
  formatNodePtyProbeFailureReason,
  formatWslShellTransportFailureReason,
  parseNodePath,
  parseNodeVersion,
  parseResolvedPath,
  parseToolchainReport,
  parseWslRuntimeRoot,
  probeWslDistros,
  sanitizeWslRuntimeId,
} from "./DesktopWslEnvironment.ts";

const encoder = new TextEncoder();

// The install script only fails the way this file cares about when a real shell
// runs it, so find one that has the tools it needs: bash directly on Linux, and
// the WSL distro on a Windows dev box, where Git Bash ships no flock. Anywhere
// else the executed suite skips and the generated-text assertions stand alone.
const REQUIRED_SHELL_TOOLS = ["flock", "sha256sum", "tar", "mktemp"] as const;

const posixShellRunner = (() => {
  // Candidates rather than a platform switch: wsl.exe simply fails to spawn
  // where it does not exist, which is the same answer as a shell missing flock.
  const candidates = [
    { file: "bash", args: [] as ReadonlyArray<string> },
    { file: "wsl.exe", args: ["-e", "bash"] as ReadonlyArray<string> },
  ];
  const probe = [
    "[ -d /proc/1 ] || exit 1",
    ...REQUIRED_SHELL_TOOLS.map((tool) => `command -v ${tool} >/dev/null || exit 1`),
  ].join("\n");
  return (
    candidates.find((candidate) => {
      const result = NodeChildProcess.spawnSync(candidate.file, [...candidate.args, "-c", probe], {
        encoding: "utf8",
      });
      return result.status === 0;
    }) ?? null
  );
})();

const runShell = (script: string) => {
  if (posixShellRunner === null) throw new Error("no POSIX shell runner available");
  // The install script arrives on stdin in production too, which is what lets
  // its own /proc scan not match itself.
  const result = NodeChildProcess.spawnSync(
    posixShellRunner.file,
    [...posixShellRunner.args, "-s"],
    { input: script, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const readField = (stdout: string, field: string) => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${field}:`));
  if (line === undefined) throw new Error(`missing ${field} in fixture output: ${stdout}`);
  return line.slice(field.length + 1).trim();
};

const SERVER_ENTRY_SOURCE = 'console.log("t3code wsl runtime test server");';

const makeDistroListSpawner = (result: { readonly stdout?: string; readonly exitCode?: number }) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          result.exitCode === undefined
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(result.exitCode === undefined),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result.stdout ?? "")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

describe("probeWslDistros", () => {
  it.effect("preserves a successful empty distro list", () =>
    Effect.gen(function* () {
      const distros = yield* probeWslDistros;
      expect(distros).toEqual([]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeDistroListSpawner({ stdout: "", exitCode: 0 }),
      ),
    ),
  );

  it.effect("fails when the distro-list command exits unsuccessfully", () =>
    Effect.gen(function* () {
      const error = yield* probeWslDistros.pipe(Effect.flip);
      expect(error).toBeInstanceOf(DesktopWslDistroListError);
      expect(error.message).toContain("exited with code 1");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeDistroListSpawner({ exitCode: 1 }),
      ),
    ),
  );

  it.effect("fails when the distro-list command times out", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeDistroListSpawner({})),
    );
    return Effect.gen(function* () {
      const fiber = yield* probeWslDistros.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(8));
      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(DesktopWslDistroListError);
      expect(error.message).toContain("timed out");
    }).pipe(Effect.provide(layer));
  });
});

describe("formatNodePtyProbeFailureReason", () => {
  it("identifies a packaged build that omitted the Linux node-pty prebuild", () => {
    const reason = formatNodePtyProbeFailureReason(4);

    expect(reason).toContain("packaged Linux node-pty binary was not included");
    expect(reason).toContain("--wsl-prebuild");
  });

  it("leaves other node-pty load failures to the compatibility diagnostic", () => {
    expect(formatNodePtyProbeFailureReason(1)).toBeNull();
  });
});

describe("formatWslShellTransportFailureReason", () => {
  it("distinguishes timeouts and spawn failures from normal shell exit codes", () => {
    expect(formatWslShellTransportFailureReason("timeout")).toContain("timed out");
    expect(formatWslShellTransportFailureReason("spawn")).toContain("could not start wsl.exe");
    expect(formatWslShellTransportFailureReason("process")).toContain("lost communication");
    expect(formatWslShellTransportFailureReason(null)).toBeNull();
  });
});

describe("buildWslNodeEnvPreamble", () => {
  it("passes the required Node engine range into the shared resolver", () => {
    const preamble = buildWslNodeEnvPreamble("^22.16 || ^23.11 || >=24.10");

    expect(preamble).toContain("T3_NODE_ENGINE_RANGE='^22.16 || ^23.11 || >=24.10'");
    expect(preamble.indexOf("T3_NODE_ENGINE_RANGE=")).toBeLessThan(
      preamble.lastIndexOf("ensure_remote_node_path || true"),
    );
  });

  it("keeps the shared resolver permissive when no Node engine range is provided", () => {
    expect(buildWslNodeEnvPreamble()).toContain("T3_NODE_ENGINE_RANGE=''");
  });
});

describe("WSL runtime cache", () => {
  it("sanitizes cache ids before interpolating them into Linux paths", () => {
    expect(sanitizeWslRuntimeId("1.2.3/x64; touch /tmp/nope")).toBe("1.2.3_x64__touch__tmp_nope");
  });

  it("installs through a temporary directory and only reuses valid completed caches", () => {
    const script = buildWslRuntimeInstallScript(
      "/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz",
      "1.2.3-x64",
      "b".repeat(64),
    );

    expect(script).toContain('runtime_parent="$HOME/.t3/wsl-runtime"');
    expect(script).toContain('  [ -f "$ready_marker" ] &&');
    expect(script).toContain('  [ -f "$runtime_root/apps/server/dist/bin.mjs" ] &&');
    expect(script).toContain('  [ -f "$runtime_root/node_modules/node-pty/package.json" ] &&');
    expect(script).toContain('    node_pty_payload_present "$runtime_root"');
    expect(script).toContain("if runtime_is_ready; then");
    expect(script).toContain("trap 'exit 1' HUP INT TERM");
    expect(script).toContain('exec 9> "$runtime_lock"');
    expect(script).toContain("flock -x 9");
    expect(script).not.toContain('rm -rf "$runtime_lock"');
    expect(script).toContain('mv -T "$runtime_root" "$runtime_stale"');
    expect(script).toContain('mktemp -d "$runtime_parent/.1.2.3-x64.tmp.XXXXXX"');
    expect(script).toContain(
      "tar -xzf '/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz' -C \"$runtime_tmp\"",
    );
    expect(script).toContain('test -f "$runtime_tmp/apps/server/dist/bin.mjs"');
    expect(script).toContain('test -f "$runtime_tmp/node_modules/node-pty/package.json"');
    expect(script).toContain('mv -T "$runtime_tmp" "$runtime_root"');
    expect(script).not.toContain('rm -rf "$runtime_root"');

    const lockAcquired = script.indexOf("flock -x 9");
    const readinessAfterLock = script.indexOf("if runtime_is_ready; then", lockAcquired + 1);
    const existingRuntimeMoved = script.indexOf('mv -T "$runtime_root" "$runtime_stale"');
    expect(lockAcquired).toBeGreaterThan(-1);
    expect(readinessAfterLock).toBeGreaterThan(lockAcquired);
    expect(existingRuntimeMoved).toBeGreaterThan(readinessAfterLock);
  });

  it("verifies the archive digest before extracting, and only on a cache miss", () => {
    const script = buildWslRuntimeInstallScript(
      "/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz",
      "1.2.3-x64",
      "b".repeat(64),
    );

    const expected = "b".repeat(64);
    expect(script).toContain(
      "archive_sha=$(sha256sum '/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz' | cut -d ' ' -f 1)",
    );
    expect(script).toContain(`if [ "$archive_sha" != '${expected}' ]; then`);

    // A warm cache exits before the hash, so reuse never pays for it, and the
    // mismatch check runs before anything mutates the cache.
    const readyShortCircuit = script.indexOf("if runtime_is_ready; then");
    const digestChecked = script.indexOf("archive_sha=$(sha256sum");
    const existingRuntimeMoved = script.indexOf('mv -T "$runtime_root" "$runtime_stale"');
    const extracted = script.indexOf("tar -xzf");
    expect(digestChecked).toBeGreaterThan(readyShortCircuit);
    expect(existingRuntimeMoved).toBeGreaterThan(digestChecked);
    expect(extracted).toBeGreaterThan(digestChecked);
  });

  // Invalidation revokes the ready marker without stopping the backend that
  // failed the probe, so the next install can find an unready tree that a live
  // process is still running out of. Deleting it there unlinks node_modules
  // under that process; the pruner already refuses to touch in-use caches, and
  // the install path has to refuse too.
  it("moves an in-use runtime aside instead of deleting it under a live backend", () => {
    const script = buildWslRuntimeInstallScript(
      "/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz",
      "sha256-" + "c".repeat(64),
      "b".repeat(64),
    );

    expect(script).toContain('grep -qF -- "$1/" /proc/[0-9]*/cmdline 2>/dev/null');
    // No /proc means no way to tell, and guessing wrong costs a backend its
    // runtime, so an unknowable answer has to count as in use.
    expect(script).toContain("  [ -d /proc/1 ] || return 0");
    expect(script).toContain('  if runtime_in_use "$runtime_root"; then');

    // A process's cmdline keeps the pre-rename path, so the question is only
    // answerable before the move.
    const inUseChecked = script.indexOf('if runtime_in_use "$runtime_root"; then');
    const moved = script.indexOf('mv -T "$runtime_root" "$runtime_stale"');
    expect(inUseChecked).toBeGreaterThan(-1);
    expect(inUseChecked).toBeLessThan(moved);

    // In use: keep the tree and restart the sweep's clock, because renaming
    // preserves the directory's mtime and a long-installed tree would otherwise
    // already be past the age gate. Idle: delete it now, as before.
    const kept = script.indexOf('touch "$runtime_stale"');
    const deleted = script.indexOf('rm -rf "$runtime_stale"');
    expect(kept).toBeGreaterThan(moved);
    expect(deleted).toBeGreaterThan(kept);
  });

  it("treats a runtime whose native payload went missing as a cache miss", () => {
    const script = buildWslRuntimeInstallScript(
      "/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz",
      "1.2.3-x64",
      "b".repeat(64),
    );

    // A glob, not a mapped `uname -m`: this is a presence check, and the later
    // native probe is what judges arch and loadability.
    expect(script).toContain(
      '  for candidate in "$1"/node_modules/node-pty/prebuilds/linux-*/pty.node; do',
    );
    // The marker the probe reads must sit beside the binary, or the runtime is
    // just as unusable as one missing pty.node outright.
    expect(script).toContain('    [ -f "${candidate%/*}/t3code-wsl-node-pty.json" ] || continue');

    // Readiness gates the short-circuit, so a cache missing the payload
    // reinstalls from the archive instead of being reused forever.
    const payloadCheckDefined = script.indexOf("node_pty_payload_present() {");
    const readinessDefined = script.indexOf("runtime_is_ready() {");
    const readyShortCircuit = script.indexOf("if runtime_is_ready; then");
    expect(payloadCheckDefined).toBeGreaterThan(-1);
    expect(payloadCheckDefined).toBeLessThan(readinessDefined);
    expect(readinessDefined).toBeLessThan(readyShortCircuit);
  });

  // A truncated or half-written bin.mjs passes every presence check the cache
  // had: the file exists, node-pty still loads, and launch then picks a server
  // that exits before it becomes ready — forever, because nothing ever
  // reinstalls. The digest the install records is what turns that into a miss.
  it("re-hashes the server entry against the digest the install recorded", () => {
    const script = buildWslRuntimeInstallScript(
      "/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz",
      "1.2.3-x64",
      "b".repeat(64),
    );

    expect(script).toContain(
      `  sha256sum "$1/apps/server/dist/bin.mjs" 2>/dev/null | cut -d ' ' -f 1`,
    );
    expect(script).toContain(
      '    [ "$recorded_entry_digest" = "$(runtime_server_entry_digest "$runtime_root")" ]',
    );
    // A runtime installed before the marker carried a digest reads as empty,
    // which has to be a miss rather than a pass.
    expect(script).toContain('    [ -n "$recorded_entry_digest" ] &&');
    expect(script).toContain(
      `printf '%s\\n' "$installed_entry_digest" > "$runtime_tmp/.t3code-wsl-runtime-ready"`,
    );

    // The digest is recorded after extraction and before promotion.
    const extracted = script.indexOf("tar -xzf");
    const digestRecorded = script.indexOf(
      'installed_entry_digest=$(runtime_server_entry_digest "$runtime_tmp")',
    );
    const markerWritten = script.indexOf('> "$runtime_tmp/.t3code-wsl-runtime-ready"');
    const promoted = script.indexOf('mv -T "$runtime_tmp" "$runtime_root"');
    expect(digestRecorded).toBeGreaterThan(extracted);
    expect(markerWritten).toBeGreaterThan(digestRecorded);
    expect(promoted).toBeGreaterThan(markerWritten);
  });

  it("refuses to mark an archive without a native payload as ready", () => {
    const script = buildWslRuntimeInstallScript(
      "/mnt/c/Program Files/T3 Code/wsl-runtime.tar.gz",
      "1.2.3-x64",
      "b".repeat(64),
    );

    expect(script).toContain('if ! node_pty_payload_present "$runtime_tmp"; then');

    // The extracted tree is rejected before the ready marker is written, so a
    // defective archive falls back to the mounted tree instead of caching.
    const payloadValidated = script.indexOf('node_pty_payload_present "$runtime_tmp"');
    const markerWritten = script.indexOf('> "$runtime_tmp/.t3code-wsl-runtime-ready"');
    const promoted = script.indexOf('mv -T "$runtime_tmp" "$runtime_root"');
    expect(payloadValidated).toBeGreaterThan(-1);
    expect(markerWritten).toBeGreaterThan(payloadValidated);
    expect(promoted).toBeGreaterThan(payloadValidated);
  });

  it("parses only absolute Linux runtime paths", () => {
    expect(parseWslRuntimeRoot("runtimeRoot:/home/josh/.t3/wsl-runtime/1.2.3-x64\n")).toBe(
      "/home/josh/.t3/wsl-runtime/1.2.3-x64",
    );
    expect(parseWslRuntimeRoot("runtimeRoot:relative/path\n")).toBeNull();
    expect(parseWslRuntimeRoot("noise\n")).toBeNull();
  });

  it("prunes completed runtimes except the current and newest previous cache", () => {
    const script = buildWslRuntimePruneScript("1.2.3/x64");

    expect(script).toContain('current_runtime="$runtime_parent/1.2.3_x64"');
    expect(script).toContain('[ "$candidate" -nt "$previous_runtime" ]');
    expect(script).toContain('[ "$candidate" != "$current_runtime" ] || continue');
    expect(script).toContain('[ "$candidate" != "$previous_runtime" ] || continue');
    expect(script).toContain('[ -f "$candidate/.t3code-wsl-runtime-ready" ] || continue');
    expect(script).toContain('rm -rf -- "$candidate"');
  });

  it("never deletes a runtime another backend is running from", () => {
    const script = buildWslRuntimePruneScript("1.2.3/x64");

    // The running backend's argv holds `<runtime>/apps/server/dist/bin.mjs`, so
    // the process itself is the lease and exiting releases it. Nothing has to be
    // registered up front, which is what makes this cover backends already
    // running from an older version that knows nothing about pruning.
    expect(script).toContain('  grep -qF -- "$1/" /proc/[0-9]*/cmdline 2>/dev/null');
    expect(script).toContain('  ! runtime_in_use "$candidate" || continue');

    // Without visible processes the retention rules cannot tell a live cache
    // from an abandoned one, so the sweep is skipped rather than guessed at.
    expect(script).toContain("[ -d /proc/1 ] || exit 0");

    // The guard has to gate the delete, not just exist.
    const inUseChecked = script.indexOf('! runtime_in_use "$candidate"');
    const removed = script.indexOf('rm -rf -- "$candidate"');
    expect(inUseChecked).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(inUseChecked);
  });

  it("sweeps orphaned install scratch directories the ready-marker loops cannot see", () => {
    const script = buildWslRuntimePruneScript("1.2.3/x64");

    // Dot-prefixed, so `"$runtime_parent"/*` never matches them, and they carry
    // no ready marker either; without this pass a killed install leaks forever.
    expect(script).toContain(
      'for scratch in "$runtime_parent"/.*.tmp.* "$runtime_parent"/.*.stale.*; do',
    );
    // Age guard: a scratch directory younger than this belongs to a live install.
    expect(script).toContain('find "$scratch" -maxdepth 0 -mmin +120');
  });

  it("invalidates a cache by dropping its ready marker, not the tree", () => {
    const script = buildWslRuntimeInvalidateScript("1.2.3/x64");

    // Readiness is a presence check, so a tree whose pty.node is present but
    // unloadable stays ready forever unless the probe can revoke the marker.
    expect(script).toContain('rm -f "$HOME/.t3/wsl-runtime/1.2.3_x64/.t3code-wsl-runtime-ready"');
    // Deleting the tree here would pull it out from under any backend still
    // running from it; the next install moves an unready root aside instead.
    expect(script).not.toContain("rm -rf");
  });
});

// Reading the generated script proves what it says, not what it does. A cache
// whose bin.mjs was truncated satisfied every assertion above and still got
// reused, so these run the real script against a real archive in a throwaway
// HOME and check the outcome.
describe.skipIf(posixShellRunner === null)("WSL runtime install script (executed)", () => {
  const fixtures: Array<string> = [];

  afterAll(() => {
    for (const work of fixtures) runShell(`set -eu\nrm -rf ${sh(work)}`);
    fixtures.length = 0;
  });

  const createFixture = () => {
    const result = runShell(
      [
        "set -eu",
        "work=$(mktemp -d)",
        'stage="$work/stage"',
        'mkdir -p "$stage/apps/server/dist" "$stage/node_modules/node-pty/prebuilds/linux-x64" "$work/home"',
        `printf '%s' ${sh(SERVER_ENTRY_SOURCE)} > "$stage/apps/server/dist/bin.mjs"`,
        `printf '%s' '{"name":"node-pty","version":"0.0.0-test"}' > "$stage/node_modules/node-pty/package.json"`,
        `printf '%s' 'pty-native-payload' > "$stage/node_modules/node-pty/prebuilds/linux-x64/pty.node"`,
        `printf '%s' '{"arch":"x64"}' > "$stage/node_modules/node-pty/prebuilds/linux-x64/t3code-wsl-node-pty.json"`,
        `tar -czf "$work/wsl-runtime.tar.gz" -C "$stage" apps/server/dist node_modules`,
        `printf 'work:%s\\n' "$work"`,
        `printf 'archiveSha:%s\\n' "$(sha256sum "$work/wsl-runtime.tar.gz" | cut -d ' ' -f 1)"`,
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);

    const work = readField(result.stdout, "work");
    fixtures.push(work);
    const archivePath = `${work}/wsl-runtime.tar.gz`;
    const archiveSha = readField(result.stdout, "archiveSha");
    const runtimeId = `sha256-${archiveSha}`;
    // The script reads $HOME, and WSL does not inherit the parent process's
    // environment, so the home override rides in the script itself.
    const installScript = (archive = archivePath, sha = archiveSha) =>
      [
        `HOME=${sh(`${work}/home`)}`,
        "export HOME",
        buildWslRuntimeInstallScript(archive, runtimeId, sha),
      ].join("\n");
    return {
      work,
      archivePath,
      archiveSha,
      runtimeId,
      runtimeParent: `${work}/home/.t3/wsl-runtime`,
      runtimeRoot: `${work}/home/.t3/wsl-runtime/${runtimeId}`,
      serverEntry: `${work}/home/.t3/wsl-runtime/${runtimeId}/apps/server/dist/bin.mjs`,
      installScript,
      install: (archive?: string, sha?: string) => runShell(installScript(archive, sha)),
    };
  };

  it("reuses a warm cache without touching the archive", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    // Deleting the archive is how the test tells reuse apart from a silent
    // reinstall: only the warm path can succeed without it.
    expect(runShell(`set -eu\nrm ${sh(fixture.archivePath)}`).status).toBe(0);

    const warm = fixture.install();

    expect(warm.status, warm.stderr).toBe(0);
    expect(parseWslRuntimeRoot(warm.stdout)).toBe(fixture.runtimeRoot);
  });

  it("reinstalls a cache whose server entry was truncated", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\n: > ${sh(fixture.serverEntry)}`).status).toBe(0);

    const repaired = fixture.install();

    expect(repaired.status, repaired.stderr).toBe(0);
    expect(parseWslRuntimeRoot(repaired.stdout)).toBe(fixture.runtimeRoot);
    const restored = runShell(`set -eu\ncat ${sh(fixture.serverEntry)}`);
    expect(restored.stdout).toBe(SERVER_ENTRY_SOURCE);
  });

  it("falls back instead of launching a corrupted cache it cannot reinstall", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\n: > ${sh(fixture.serverEntry)}`).status).toBe(0);
    expect(runShell(`set -eu\nrm ${sh(fixture.archivePath)}`).status).toBe(0);

    const broken = fixture.install();

    // Non-zero with no runtimeRoot is what sends the backend to the mounted
    // server tree. Exiting 0 here is the bug: launch would pick the zero-byte
    // server, fail to become ready, and do it again on every restart.
    expect(broken.status).not.toBe(0);
    expect(parseWslRuntimeRoot(broken.stdout)).toBeNull();
  });

  it("extracts once when two installs race for the same cache", () => {
    const fixture = createFixture();
    // A tar shim counts extractions and holds the critical section open long
    // enough that the second install is certain to arrive while the first is
    // still inside it. One extraction is the answer either way the runs
    // interleave: whoever waits for the lock re-checks readiness before
    // spending an extract, so a broken lock shows up as two.
    const raced = runShell(
      [
        "set -eu",
        `work=${sh(fixture.work)}`,
        'mkdir -p "$work/bin"',
        "real_tar=$(command -v tar)",
        `printf '#!/bin/sh\\nprintf x >> "%s/tar-calls"\\nsleep 1\\nexec %s "$@"\\n' "$work" "$real_tar" > "$work/bin/tar"`,
        'chmod +x "$work/bin/tar"',
        ': > "$work/tar-calls"',
        'PATH="$work/bin:$PATH"',
        "export PATH",
        `cat > "$work/install.sh" <<'T3CODE_INSTALL_SCRIPT'`,
        fixture.installScript(),
        "T3CODE_INSTALL_SCRIPT",
        // Both racers run the same file, and neither file path contains the
        // runtime root, so the script's own /proc scan cannot see them.
        'sh "$work/install.sh" > "$work/first.out" 2>&1 &',
        "first=$!",
        'sh "$work/install.sh" > "$work/second.out" 2>&1 &',
        "second=$!",
        "if wait $first; then first_status=0; else first_status=$?; fi",
        "if wait $second; then second_status=0; else second_status=$?; fi",
        `printf 'firstStatus:%s\\n' "$first_status"`,
        `printf 'secondStatus:%s\\n' "$second_status"`,
        `printf 'extractions:%s\\n' "$(wc -c < "$work/tar-calls" | tr -d ' ')"`,
        `printf 'firstRoot:%s\\n' "$(sed -n 's/^runtimeRoot://p' "$work/first.out")"`,
        `printf 'secondRoot:%s\\n' "$(sed -n 's/^runtimeRoot://p' "$work/second.out")"`,
      ].join("\n"),
    );

    expect(raced.status, raced.stderr).toBe(0);
    expect(readField(raced.stdout, "firstStatus")).toBe("0");
    expect(readField(raced.stdout, "secondStatus")).toBe("0");
    expect(readField(raced.stdout, "extractions")).toBe("1");
    expect(readField(raced.stdout, "firstRoot")).toBe(fixture.runtimeRoot);
    expect(readField(raced.stdout, "secondRoot")).toBe(fixture.runtimeRoot);
  });

  it("leaves no half-built cache when extraction fails", () => {
    const fixture = createFixture();
    // Truncating the archive and re-recording its digest gets the install past
    // the digest gate and into a tar that dies mid-stream, which is what a full
    // disk or an interrupted write looks like from inside the distro.
    const truncated = runShell(
      [
        "set -eu",
        `work=${sh(fixture.work)}`,
        'size=$(wc -c < "$work/wsl-runtime.tar.gz")',
        'head -c $((size / 2)) "$work/wsl-runtime.tar.gz" > "$work/truncated.tar.gz"',
        `printf 'sha:%s\\n' "$(sha256sum "$work/truncated.tar.gz" | cut -d ' ' -f 1)"`,
      ].join("\n"),
    );
    expect(truncated.status, truncated.stderr).toBe(0);

    const failed = fixture.install(
      `${fixture.work}/truncated.tar.gz`,
      readField(truncated.stdout, "sha"),
    );

    expect(failed.status).not.toBe(0);
    expect(parseWslRuntimeRoot(failed.stdout)).toBeNull();
    // A partial extract that survived under the cache name would be promoted by
    // the next launch's readiness check; scratch that survived would sit there
    // until the pruner's age sweep. Neither is left behind. Only directories
    // are counted: the empty flock file stays on purpose, which is what keeps
    // the lock from carrying stale state across a killed install.
    const leftovers = runShell(
      `set -eu\nfind ${sh(fixture.runtimeParent)} -mindepth 1 -maxdepth 1 -type d`,
    );
    expect(leftovers.stdout.trim()).toBe("");
  });

  // The archive and the identity recorded beside it can diverge — a partial
  // download, or a rebuilt archive dropped next to an older sidecar. Either
  // gate firing means the bytes never reach the cache under a name that claims
  // to describe something else.
  it("refuses an archive whose bytes do not match the digest recorded for it", () => {
    const fixture = createFixture();

    const refused = fixture.install(fixture.archivePath, "e".repeat(64));

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("does not match its recorded SHA-256");
    expect(parseWslRuntimeRoot(refused.stdout)).toBeNull();
    const leftovers = runShell(
      `set -eu\nfind ${sh(fixture.runtimeParent)} -mindepth 1 -maxdepth 1 -type d`,
    );
    expect(leftovers.stdout.trim()).toBe("");
  });

  it("leases a warm cache across the prepare-to-spawn handoff", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const selected = runShell(
      [
        "set -eu",
        `runtime_parent=${sh(fixture.runtimeParent)}`,
        'mkdir -p "$runtime_parent/sha256-current" "$runtime_parent/sha256-previous"',
        'printf ready > "$runtime_parent/sha256-current/.t3code-wsl-runtime-ready"',
        'printf ready > "$runtime_parent/sha256-previous/.t3code-wsl-runtime-ready"',
        `touch -d "10 minutes ago" ${sh(fixture.runtimeRoot)}`,
        'touch -d "1 minute ago" "$runtime_parent/sha256-previous"',
        `cat > ${sh(`${fixture.work}/select.sh`)} <<'T3CODE_SELECT_SCRIPT'`,
        fixture.installScript(),
        "T3CODE_SELECT_SCRIPT",
        `sh ${sh(`${fixture.work}/select.sh`)}`,
        `HOME=${sh(`${fixture.work}/home`)}`,
        "export HOME",
        buildWslRuntimePruneScript("sha256-current"),
        `test -d ${sh(fixture.runtimeRoot)}`,
      ].join("\n"),
    );

    expect(selected.status, `${selected.stdout}\n${selected.stderr}`).toBe(0);
  });

  it("prunes a selected cache after its prepare-to-spawn grace period expires", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const result = runShell(
      [
        "set -eu",
        `runtime_parent=${sh(fixture.runtimeParent)}`,
        'mkdir -p "$runtime_parent/sha256-current" "$runtime_parent/sha256-previous"',
        'printf ready > "$runtime_parent/sha256-current/.t3code-wsl-runtime-ready"',
        'printf ready > "$runtime_parent/sha256-previous/.t3code-wsl-runtime-ready"',
        `touch -d "10 minutes ago" ${sh(fixture.runtimeRoot)}`,
        `touch -d "10 minutes ago" ${sh(`${fixture.runtimeRoot}/.t3code-wsl-runtime-selected`)}`,
        'touch -d "1 minute ago" "$runtime_parent/sha256-previous"',
        `HOME=${sh(`${fixture.work}/home`)}`,
        "export HOME",
        buildWslRuntimePruneScript("sha256-current"),
        `test ! -e ${sh(fixture.runtimeRoot)}`,
      ].join("\n"),
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("removes an aged stale tree after replacing an active unready cache", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const result = runShell(
      [
        "set -eu",
        `runtime_root=${sh(fixture.runtimeRoot)}`,
        `runtime_parent=${sh(fixture.runtimeParent)}`,
        'rm "$runtime_root/.t3code-wsl-runtime-ready"',
        'sh -c "sleep 30" "$runtime_root/apps/server/dist/bin.mjs" >/dev/null 2>&1 &',
        "active_pid=$!",
        "sleep 0.1",
        fixture.installScript(),
        'stale=$(find "$runtime_parent" -maxdepth 1 -type d -name ".sha256-*.stale.*" -print -quit)',
        'test -n "$stale"',
        'touch -d "180 minutes ago" "$stale"',
        `HOME=${sh(`${fixture.work}/home`)}`,
        "export HOME",
        buildWslRuntimePruneScript(fixture.runtimeId),
        'test ! -e "$stale"',
        "kill $active_pid",
        "wait $active_pid 2>/dev/null || true",
      ].join("\n"),
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("prunes old and markerless caches without touching retained, active, locked, or unrelated roots", () => {
    const result = runShell(
      [
        "set -eu",
        "work=$(mktemp -d)",
        'home="$work/home"',
        'runtime_parent="$home/.t3/wsl-runtime"',
        'mkdir -p "$runtime_parent"',
        'make_ready() { mkdir -p "$runtime_parent/$1/apps/server/dist"; printf ready > "$runtime_parent/$1/.t3code-wsl-runtime-ready"; }',
        "make_ready sha256-current",
        "make_ready sha256-previous",
        "make_ready sha256-active",
        "make_ready sha256-old",
        "make_ready sha256-locked",
        'mkdir -p "$runtime_parent/sha256-markerless" "$runtime_parent/versions"',
        'touch -d "1 minute ago" "$runtime_parent/sha256-previous"',
        'touch -d "4 minutes ago" "$runtime_parent/sha256-active"',
        'touch -d "3 minutes ago" "$runtime_parent/sha256-old"',
        'touch -d "2 minutes ago" "$runtime_parent/sha256-locked"',
        'sh -c "sleep 30" "$runtime_parent/sha256-active/apps/server/dist/bin.mjs" >/dev/null 2>&1 &',
        "active_pid=$!",
        "(",
        '  exec 9> "$runtime_parent/.sha256-locked.install.lock"',
        "  flock -x 9",
        "  sleep 30",
        ") >/dev/null 2>&1 &",
        "lock_pid=$!",
        "sleep 0.1",
        `HOME="$home"`,
        "export HOME",
        buildWslRuntimePruneScript("sha256-current"),
        'test -d "$runtime_parent/sha256-current"',
        'test -d "$runtime_parent/sha256-previous"',
        'test -d "$runtime_parent/sha256-active"',
        'test -d "$runtime_parent/sha256-locked"',
        'test -d "$runtime_parent/versions"',
        'test ! -e "$runtime_parent/sha256-old"',
        'test ! -e "$runtime_parent/sha256-markerless"',
        "kill $active_pid $lock_pid",
        "wait $active_pid 2>/dev/null || true",
        "wait $lock_pid 2>/dev/null || true",
        'rm -rf "$work"',
      ].join("\n"),
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

describe("parseToolchainReport", () => {
  it("returns no missing tools and no node version on empty output", () => {
    expect(parseToolchainReport("")).toEqual({ missingTools: [], nodeVersion: null });
  });

  it("collects all missing: lines", () => {
    const stdout = ["missing:make", "missing:g++", "nodeVersion:24.10.0"].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["make", "g++"],
      nodeVersion: "24.10.0",
    });
  });

  it("ignores blank lines and trims whitespace", () => {
    const stdout = ["  missing:python3  ", "", "  nodeVersion:v22.16.0  "].join("\n");
    expect(parseToolchainReport(stdout)).toEqual({
      missingTools: ["python3"],
      nodeVersion: "v22.16.0",
    });
  });

  it("returns null node version when value after prefix is empty", () => {
    expect(parseToolchainReport("nodeVersion:")).toEqual({
      missingTools: [],
      nodeVersion: null,
    });
  });
});

describe("parseNodePath", () => {
  it("extracts the absolute node path from a nodePath: line", () => {
    const stdout = "nodePath:/home/josh/.nvm/versions/node/v22.16.0/bin/node";
    expect(parseNodePath(stdout)).toBe("/home/josh/.nvm/versions/node/v22.16.0/bin/node");
  });

  it("returns null when node was not found (empty value after prefix)", () => {
    expect(parseNodePath("nodePath:")).toBeNull();
  });

  it("returns null when there is no nodePath line at all", () => {
    expect(parseNodePath("missing:node\nnodeVersion:")).toBeNull();
  });

  it("ignores surrounding noise and trims whitespace", () => {
    const stdout = ["some preamble noise", "  nodePath:/usr/bin/node  ", "trailing"].join("\n");
    expect(parseNodePath(stdout)).toBe("/usr/bin/node");
  });
});

describe("parseNodeVersion", () => {
  it("extracts the node version from a nodeVersion: line", () => {
    expect(parseNodeVersion("nodeVersion:24.10.0")).toBe("24.10.0");
  });

  it("returns null when the version value is empty", () => {
    expect(parseNodeVersion("nodeVersion:")).toBeNull();
  });

  it("returns null when there is no nodeVersion line at all", () => {
    expect(parseNodeVersion("nodePath:/usr/bin/node\nresolvedPath:/usr/bin")).toBeNull();
  });

  it("ignores surrounding noise and trims whitespace", () => {
    const stdout = [
      "some preamble noise",
      "  nodeVersion:22.16.0  ",
      "nodePath:/usr/bin/node",
    ].join("\n");
    expect(parseNodeVersion(stdout)).toBe("22.16.0");
  });
});

describe("parseResolvedPath", () => {
  it("preserves spaces and apostrophes in the resolved login-shell PATH", () => {
    const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
    expect(parseResolvedPath(`nodePath:/usr/bin/node\nresolvedPath:${resolvedPath}\n`)).toBe(
      resolvedPath,
    );
  });

  it("accepts CRLF output without retaining the carriage return", () => {
    expect(parseResolvedPath("resolvedPath:/usr/local/bin:/usr/bin\r\n")).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });

  it("returns null when the resolved PATH is absent or empty", () => {
    expect(parseResolvedPath("nodePath:/usr/bin/node\n")).toBeNull();
    expect(parseResolvedPath("resolvedPath:\n")).toBeNull();
  });
});

describe("formatMissingToolsReason", () => {
  it("returns null when everything is present and node is in range", () => {
    expect(
      formatMissingToolsReason({ missingTools: [], nodeVersion: "24.10.0" }, "^24.10"),
    ).toBeNull();
  });

  it("returns null when range is not specified and tools are present", () => {
    expect(formatMissingToolsReason({ missingTools: [], nodeVersion: "18.0.0" }, null)).toBeNull();
  });

  it("flags missing node first", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["node", "make"], nodeVersion: null },
      "^24.10",
    );
    expect(reason).toContain("node");
    expect(reason).toContain("^24.10");
    expect(reason).toContain("make");
    expect(reason).toContain("nvm");
  });

  it("flags an out-of-range node version with the actual version surfaced", () => {
    const reason = formatMissingToolsReason(
      { missingTools: [], nodeVersion: "20.0.0" },
      "^24.10 || ^22.16",
    );
    expect(reason).toContain("node 20.0.0");
    expect(reason).toContain("requires ^24.10 || ^22.16");
  });

  it("flags missing build tools without node when node is fine", () => {
    const reason = formatMissingToolsReason(
      { missingTools: ["g++", "python3"], nodeVersion: "24.10.0" },
      "^24.10",
    );
    expect(reason).toContain("g++");
    expect(reason).toContain("python3");
    expect(reason).toContain("build-essential");
    expect(reason).not.toContain("nvm");
  });
});
