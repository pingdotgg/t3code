import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildWslNodeEnvPreamble,
  DesktopWslDistroListError,
  ensureNodePtyImpl,
  formatMissingToolsReason,
  formatNodePtyProbeFailureReason,
  formatWslShellTransportFailureReason,
  parseNodePath,
  parseNodeVersion,
  parseResolvedPath,
  parseToolchainReport,
  probeWslDistros,
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

describe("parseNodeVersion", () => {
  it("extracts the version from a nodeVersion: line", () => {
    const stdout = "nodePath:/usr/bin/node\nresolvedPath:/usr/bin\nnodeVersion:18.20.8\n";
    expect(parseNodeVersion(stdout)).toBe("18.20.8");
  });

  it("returns null when there is no nodeVersion line at all", () => {
    expect(parseNodeVersion("nodePath:/usr/bin/node\nresolvedPath:/usr/bin\n")).toBeNull();
  });

  it("returns null when the value after the prefix is empty", () => {
    expect(parseNodeVersion("nodeVersion:\n")).toBeNull();
  });

  it("trims surrounding whitespace and a trailing carriage return", () => {
    expect(parseNodeVersion("  nodeVersion:22.22.1\r\n")).toBe("22.22.1");
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

describe("ensureNodePtyImpl: WSL Node engine-range preflight (#3611)", () => {
  // Always resolves -- isolates the engine-range branch from the separate
  // `wslpath` round trip that production windowsToWslPath performs.
  const windowsToWslPath = () => Effect.succeed(Option.some("/home/josh/repo"));

  const makeProbeSpawner = (probeStdout: string) =>
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(probeStdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );

  it("rejects a resolved Node that does not satisfy nodeEngineRange (the reporter's exact case)", () =>
    Effect.gen(function* () {
      const result = yield* ensureNodePtyImpl(
        "Ubuntu",
        "C:\\repo",
        windowsToWslPath,
        { nodeEngineRange: "^22.16 || ^23.11 || >=24.10" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.fatal).toBe(true);
        expect(result.reason).toContain("18.20.8");
        expect(result.reason).toContain("^22.16 || ^23.11 || >=24.10");
        expect(result.reason).toContain("/home/josh/.nvm/versions/node/v18.20.8/bin/node");
      }
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeProbeSpawner(
          [
            "nodePath:/home/josh/.nvm/versions/node/v18.20.8/bin/node",
            "resolvedPath:/home/josh/.nvm/versions/node/v18.20.8/bin:/usr/bin",
            "nodeVersion:18.20.8",
          ].join("\n"),
        ),
      ),
    ));

  it("does not false-positive when the resolved Node satisfies nodeEngineRange (happy path unchanged)", () =>
    Effect.gen(function* () {
      const result = yield* ensureNodePtyImpl(
        "Ubuntu",
        "C:\\repo",
        windowsToWslPath,
        { nodeEngineRange: "^22.16 || ^23.11 || >=24.10" },
      );
      expect(result).toEqual({
        ok: true,
        nodePath: "/home/josh/.nvm/versions/node/v22.22.1/bin/node",
        resolvedPath: "/home/josh/.nvm/versions/node/v22.22.1/bin:/usr/bin",
      });
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeProbeSpawner(
          [
            "nodePath:/home/josh/.nvm/versions/node/v22.22.1/bin/node",
            "resolvedPath:/home/josh/.nvm/versions/node/v22.22.1/bin:/usr/bin",
            "nodeVersion:22.22.1",
          ].join("\n"),
        ),
      ),
    ));

  it("does not check the engine range when nodeEngineRange is not configured", () =>
    Effect.gen(function* () {
      const result = yield* ensureNodePtyImpl("Ubuntu", "C:\\repo", windowsToWslPath, {});
      expect(result).toEqual({
        ok: true,
        nodePath: "/home/josh/.nvm/versions/node/v18.20.8/bin/node",
        resolvedPath: "/home/josh/.nvm/versions/node/v18.20.8/bin:/usr/bin",
      });
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeProbeSpawner(
          [
            "nodePath:/home/josh/.nvm/versions/node/v18.20.8/bin/node",
            "resolvedPath:/home/josh/.nvm/versions/node/v18.20.8/bin:/usr/bin",
            "nodeVersion:18.20.8",
          ].join("\n"),
        ),
      ),
    ));
});
