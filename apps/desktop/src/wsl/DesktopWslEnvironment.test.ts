import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildWslRuntimeInvalidateScript,
  buildWslRuntimePruneScript,
  buildWslRuntimeInstallScript,
  buildWslNodeEnvPreamble,
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

    expect(script).toContain('  [ -f "$ready_marker" ] &&');
    expect(script).toContain('  [ -f "$runtime_root/apps/server/dist/bin.mjs" ] &&');
    expect(script).toContain('  [ -f "$runtime_root/node_modules/node-pty/package.json" ] &&');
    expect(script).toContain('    node_pty_payload_present "$runtime_root"');
    expect(script).not.toContain("node_modules/effect/package.json");
    expect(script).toContain("if runtime_is_ready; then");
    expect(script).toContain("trap 'exit 1' HUP INT TERM");
    expect(script).toContain('exec 9> "$runtime_lock"');
    expect(script).toContain("flock -x 9");
    expect(script).not.toContain("runtime_lock_pid");
    expect(script).not.toContain("sleep 0.1");
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
    const markerWritten = script.indexOf(': > "$runtime_tmp/.t3code-wsl-runtime-ready"');
    const promoted = script.indexOf('mv -T "$runtime_tmp" "$runtime_root"');
    expect(payloadValidated).toBeGreaterThan(-1);
    expect(markerWritten).toBeGreaterThan(payloadValidated);
    expect(promoted).toBeGreaterThan(payloadValidated);
  });

  it("parses only absolute Linux runtime paths", () => {
    expect(parseWslRuntimeRoot("runtimeRoot:/home/josh/.t3/runtime/1.2.3-x64\n")).toBe(
      "/home/josh/.t3/runtime/1.2.3-x64",
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
      "find \"$runtime_parent\" -maxdepth 1 -type d \\( -name '.*.tmp.*' -o -name '.*.stale.*' \\)",
    );
    // Age guard: a scratch directory younger than this belongs to a live install.
    expect(script).toContain("-mmin +120 -exec rm -rf -- {} +");
  });

  it("invalidates a cache by dropping its ready marker, not the tree", () => {
    const script = buildWslRuntimeInvalidateScript("1.2.3/x64");

    // Readiness is a presence check, so a tree whose pty.node is present but
    // unloadable stays ready forever unless the probe can revoke the marker.
    expect(script).toContain('rm -f "$HOME/.t3/runtime/1.2.3_x64/.t3code-wsl-runtime-ready"');
    // Deleting the tree here would pull it out from under any backend still
    // running from it; the next install moves an unready root aside instead.
    expect(script).not.toContain("rm -rf");
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
