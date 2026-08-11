// @effect-diagnostics nodeBuiltinImport:off - these integration tests execute real POSIX shell tools against disposable directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
  buildPackagedRuntimeStageScript,
  buildWslNodeEnvPreamble,
  DesktopWslDistroListError,
  formatMissingToolsReason,
  formatNodePtyProbeFailureReason,
  formatPackagedRuntimeStageFailure,
  formatWslShellTransportFailureReason,
  parseNodePath,
  parseNodeVersion,
  parseResolvedPath,
  parseToolchainReport,
  probeWslDistros,
  WSL_SCRIPT_SHELL_ARGS,
} from "./DesktopWslEnvironment.ts";
import { parseWslRuntimeArchiveHash } from "@t3tools/shared/wslRuntimeArchive";

const encoder = new TextEncoder();

const makeRuntimeArchiveFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wsl-runtime-"));
  const source = NodePath.join(root, "source");
  const archive = NodePath.join(root, "wsl-runtime.tar.gz");
  const tools = NodePath.join(root, "tools");
  const cache = NodePath.join(root, "cache");
  NodeFS.mkdirSync(NodePath.join(source, "apps/server/dist"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(source, "node_modules/effect"), { recursive: true });
  NodeFS.mkdirSync(tools);
  NodeFS.writeFileSync(NodePath.join(source, "apps/server/dist/bin.mjs"), "version one\n");
  NodeFS.writeFileSync(NodePath.join(source, "node_modules/effect/package.json"), "{}\n");
  NodeFS.writeFileSync(NodePath.join(tools, "wslpath"), '#!/bin/sh\nprintf "%s\\n" "$2"\n', {
    mode: 0o755,
  });

  const pack = () => {
    const result = NodeChildProcess.spawnSync(
      "tar",
      ["-czf", archive, "-C", source, "apps", "node_modules"],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(archive)).digest("hex");
  };
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${tools}:${process.env.PATH ?? ""}`,
    XDG_CACHE_HOME: cache,
  };
  const run = (archiveHash: string) =>
    NodeChildProcess.spawnSync(
      "bash",
      ["-c", buildPackagedRuntimeStageScript(archive, archiveHash)],
      { encoding: "utf8", env },
    );
  const runAsync = (archiveHash: string) =>
    new Promise<{ readonly status: number | null; readonly stderr: string }>((resolve) => {
      const child = NodeChildProcess.spawn(
        "bash",
        ["-c", buildPackagedRuntimeStageScript(archive, archiveHash)],
        { env },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stderr }));
    });
  const current = NodePath.join(cache, "t3code/desktop-wsl-runtime/current");

  return { archive, current, pack, root, run, runAsync, source, tools };
};

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

describe("WSL scripted shell transport", () => {
  const runScript = (home: string, script: string) => {
    const [, , ...bashArgs] = WSL_SCRIPT_SHELL_ARGS;
    return NodeChildProcess.spawnSync("bash", bashArgs, {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
  };

  it("preserves exported login state without letting logout hooks rewrite success", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wsl-shell-"));
    try {
      NodeFS.writeFileSync(
        NodePath.join(home, ".bash_profile"),
        "export T3_PROFILE_VALUE=loaded\n",
      );
      NodeFS.writeFileSync(NodePath.join(home, ".bash_logout"), "false\n");

      const result = runScript(home, 'set -eu\nprintf "%s\\n" "$T3_PROFILE_VALUE"\nexit 0\n');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("loaded\n");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves a scripted failure status", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wsl-shell-"));
    try {
      NodeFS.writeFileSync(NodePath.join(home, ".bash_logout"), "false\n");

      const result = runScript(home, "set -eu\nexit 17\n");

      expect(result.status).toBe(17);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
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

describe("buildPackagedRuntimeStageScript", () => {
  it("checks the Linux-native cache before converting or reading the mounted source", () => {
    const script = buildPackagedRuntimeStageScript(
      "C:\\Program Files\\T3 Code\\resources\\app.asar.unpacked",
      "1.2.3-x64",
    );
    const cacheHit = script.indexOf('if [ "$(cat "$manifest_path"');
    const sourceConversion = script.indexOf("wslpath -u");

    expect(cacheHit).toBeGreaterThanOrEqual(0);
    expect(sourceConversion).toBeGreaterThan(cacheHit);
    expect(script.slice(cacheHit, sourceConversion)).toContain(
      'runtimeRoot:%s\\n\' "$current_dir"',
    );
    expect(script.slice(cacheHit, sourceConversion)).toContain("exit 0");
  });

  it("falls back from an XDG cache on a Windows-mounted filesystem", () => {
    const script = buildPackagedRuntimeStageScript(
      "C:\\Program Files\\T3 Code\\resources\\app.asar.unpacked",
      "1.2.3-x64",
    );
    const xdgSelection = script.indexOf('cache_home="$XDG_CACHE_HOME"');
    const filesystemProbe = script.indexOf('findmnt -T "$cache_home"');
    const windowsMountFallback = script.indexOf("9p|drvfs|plan9|virtio-plan9|virtiofs");
    const runtimeBase = script.indexOf('runtime_base="$cache_home/t3code/desktop-wsl-runtime"');

    expect(filesystemProbe).toBeGreaterThan(xdgSelection);
    expect(windowsMountFallback).toBeGreaterThan(filesystemProbe);
    expect(runtimeBase).toBeGreaterThan(windowsMountFallback);
    expect(script.slice(filesystemProbe, runtimeBase)).toContain(
      'cache_home="${HOME:?WSL home directory is unavailable}/.cache"',
    );
  });

  it("serializes cache misses and rechecks the cache before reading the mounted source", () => {
    const script = buildPackagedRuntimeStageScript(
      "C:\\Program Files\\T3 Code\\resources\\app.asar.unpacked",
      "1.2.3-x64",
    );
    const firstCacheCheck = script.indexOf('if [ "$(cat "$manifest_path"');
    const lock = script.indexOf("flock -x 9");
    const secondCacheCheck = script.indexOf('if [ "$(cat "$manifest_path"', firstCacheCheck + 1);
    const sourceConversion = script.indexOf("wslpath -u");

    expect(lock).toBeGreaterThan(firstCacheCheck);
    expect(secondCacheCheck).toBeGreaterThan(lock);
    expect(sourceConversion).toBeGreaterThan(secondCacheCheck);
    expect(script).toContain('if ! source_archive=$(wslpath -u "$windows_archive_path"); then');
    expect(script.slice(sourceConversion)).toContain("exit 5");
  });

  it("extracts one packaged archive instead of copying the mounted file tree", () => {
    const script = buildPackagedRuntimeStageScript(
      "C:\\Program Files\\T3 Code\\resources\\wsl-runtime.tar.gz",
      "b".repeat(64),
    );

    expect(script).toContain('sha256sum "$source_archive"');
    expect(script).toContain('if [ "$actual_hash" != "$archive_hash" ]; then');
    expect(script).toContain('tar -xzf "$source_archive" -C "$staging_dir"');
    expect(script).not.toContain('cp -a "$source_root/." "$staging_dir/"');
  });

  it("extracts once, then starts from the native cache without reading the archive", () => {
    const fixture = makeRuntimeArchiveFixture();
    try {
      const archiveHash = fixture.pack();

      const cold = fixture.run(archiveHash);
      expect(cold.status, cold.stderr).toBe(0);
      expect(
        NodeFS.readFileSync(NodePath.join(fixture.current, ".t3code-runtime-sha256"), "utf8"),
      ).toBe(`${archiveHash}\n`);
      expect(
        NodeFS.readFileSync(NodePath.join(fixture.current, "apps/server/dist/bin.mjs"), "utf8"),
      ).toBe("version one\n");

      NodeFS.rmSync(fixture.archive);
      const warm = fixture.run(archiveHash);
      expect(warm.status, warm.stderr).toBe(0);
      expect(warm.stdout).toContain(`runtimeRoot:${fixture.current}`);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("replaces an old cache when the archive changes", () => {
    const fixture = makeRuntimeArchiveFixture();
    try {
      const firstHash = fixture.pack();
      expect(fixture.run(firstHash).status).toBe(0);

      NodeFS.writeFileSync(
        NodePath.join(fixture.source, "apps/server/dist/bin.mjs"),
        "version two\n",
      );
      const secondHash = fixture.pack();
      const updated = fixture.run(secondHash);

      expect(updated.status, updated.stderr).toBe(0);
      expect(
        NodeFS.readFileSync(NodePath.join(fixture.current, "apps/server/dist/bin.mjs"), "utf8"),
      ).toBe("version two\n");
      expect(
        NodeFS.readFileSync(NodePath.join(fixture.current, ".t3code-runtime-sha256"), "utf8"),
      ).toBe(`${secondHash}\n`);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps the last good cache when a replacement archive is broken", () => {
    const fixture = makeRuntimeArchiveFixture();
    try {
      const goodHash = fixture.pack();
      expect(fixture.run(goodHash).status).toBe(0);

      NodeFS.writeFileSync(fixture.archive, "not a tar archive\n");
      const brokenHash = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(fixture.archive))
        .digest("hex");
      const broken = fixture.run(brokenHash);

      expect(broken.status).not.toBe(0);
      expect(
        NodeFS.readFileSync(NodePath.join(fixture.current, "apps/server/dist/bin.mjs"), "utf8"),
      ).toBe("version one\n");
      expect(
        NodeFS.readFileSync(NodePath.join(fixture.current, ".t3code-runtime-sha256"), "utf8"),
      ).toBe(`${goodHash}\n`);
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent cache misses so the archive is extracted once", async () => {
    const fixture = makeRuntimeArchiveFixture();
    try {
      const archiveHash = fixture.pack();
      const extractionLog = NodePath.join(fixture.root, "tar-calls.log");
      const realTar = NodeChildProcess.spawnSync("which", ["tar"], {
        encoding: "utf8",
      }).stdout.trim();
      NodeFS.writeFileSync(
        NodePath.join(fixture.tools, "tar"),
        `#!/bin/sh\nprintf 'extract\\n' >> ${JSON.stringify(extractionLog)}\nexec ${JSON.stringify(realTar)} "$@"\n`,
        { mode: 0o755 },
      );

      const results = await Promise.all([
        fixture.runAsync(archiveHash),
        fixture.runAsync(archiveHash),
      ]);

      for (const result of results) expect(result.status, result.stderr).toBe(0);
      expect(NodeFS.readFileSync(extractionLog, "utf8")).toBe("extract\n");
    } finally {
      NodeFS.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("formatPackagedRuntimeStageFailure", () => {
  it("keeps the staging failure reason for fallback logging", () => {
    expect(formatPackagedRuntimeStageFailure(5, "wslpath conversion failed")).toEqual({
      ok: false,
      reason: "Failed to prepare the packaged WSL runtime (exit 5): wslpath conversion failed",
    });
  });
});

describe("parseWslRuntimeArchiveHash", () => {
  it("normalizes a valid SHA-256 sidecar", () => {
    expect(parseWslRuntimeArchiveHash(`${"A".repeat(64)}\n`)).toBe("a".repeat(64));
  });

  it("rejects missing and malformed identities", () => {
    expect(parseWslRuntimeArchiveHash("")).toBeNull();
    expect(parseWslRuntimeArchiveHash("not-a-hash")).toBeNull();
    expect(parseWslRuntimeArchiveHash("a".repeat(63))).toBeNull();
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
