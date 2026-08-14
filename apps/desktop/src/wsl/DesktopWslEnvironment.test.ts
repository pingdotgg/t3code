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

import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import {
  buildEnsurePathReleasedScript,
  buildWslNodeEnvPreamble,
  ensureWindowsPathReleasedImpl,
  getDistroIpsImpl,
  getNetworkingModeImpl,
  readServerRuntimeStateImpl,
  DesktopWslDistroListError,
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

const makeArgvSpawner = (
  handler: (argv: readonly string[]) => { readonly stdout?: string; readonly exitCode?: number },
) =>
  ChildProcessSpawner.make((command) => {
    const argv = command._tag === "StandardCommand" ? [command.command, ...command.args] : [];
    const result = handler(argv);
    return Effect.succeed(
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
    );
  });

describe("getDistroIpsImpl", () => {
  it.effect("returns every IPv4 in reported order, including CGNAT and bridge addresses", () =>
    Effect.gen(function* () {
      // Tailscale-in-WSL regression shape: the CGNAT address comes first and
      // the actually-reachable mirrored address second. All must be returned;
      // selection is the caller's job.
      const ips = yield* getDistroIpsImpl("Ubuntu");
      expect(ips).toEqual(["100.108.4.21", "192.168.127.5", "172.17.0.1"]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeArgvSpawner(() => ({
          stdout: "100.108.4.21 192.168.127.5 172.17.0.1 fd7c::1\n",
          exitCode: 0,
        })),
      ),
    ),
  );

  it.effect("returns an empty list when the command fails", () =>
    Effect.gen(function* () {
      const ips = yield* getDistroIpsImpl(null);
      expect(ips).toEqual([]);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeArgvSpawner(() => ({ exitCode: 1 })),
      ),
    ),
  );
});

describe("getNetworkingModeImpl", () => {
  const modeSpawner = (stdout: string | undefined, exitCode?: number) =>
    makeArgvSpawner((argv) => {
      expect(argv).toContain("wslinfo");
      expect(argv).toContain("--networking-mode");
      return exitCode === undefined && stdout === undefined
        ? {}
        : { stdout: stdout ?? "", exitCode: exitCode ?? 0 };
    });

  it.effect("parses mirrored mode", () =>
    Effect.gen(function* () {
      expect(yield* getNetworkingModeImpl("Ubuntu")).toEqual("mirrored");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, modeSpawner("mirrored\n")),
    ),
  );

  it.effect("parses nat mode", () =>
    Effect.gen(function* () {
      expect(yield* getNetworkingModeImpl(null)).toEqual("nat");
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, modeSpawner("nat\n"))),
  );

  it.effect("reports unknown when wslinfo is missing or fails", () =>
    Effect.gen(function* () {
      expect(yield* getNetworkingModeImpl(null)).toEqual("unknown");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, modeSpawner(undefined, 127)),
    ),
  );

  it.effect("reports unknown for unrecognized output", () =>
    Effect.gen(function* () {
      expect(yield* getNetworkingModeImpl(null)).toEqual("unknown");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, modeSpawner("bridged\n")),
    ),
  );
});

describe("readServerRuntimeStateImpl", () => {
  it.effect("parses the persisted runtime state from the requested state dir", () =>
    Effect.gen(function* () {
      const state = yield* readServerRuntimeStateImpl("Ubuntu", "userdata");
      expect(Option.isSome(state)).toBe(true);
      if (Option.isSome(state)) {
        expect(state.value.port).toBe(3773);
        expect(state.value.origin).toBe("http://127.0.0.1:3773");
        expect(state.value.host).toBe("0.0.0.0");
      }
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeArgvSpawner((argv) => {
          expect(argv.join(" ")).toContain(".t3/userdata/server-runtime.json");
          expect(argv.join(" ")).not.toContain(".t3/dev/");
          return {
            stdout:
              '{"version":1,"pid":4242,"host":"0.0.0.0","port":3773,"origin":"http://127.0.0.1:3773","startedAt":"2026-08-09T17:15:00Z"}\n',
            exitCode: 0,
          };
        }),
      ),
    ),
  );

  it.effect("returns none for a missing or unparsable file", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* readServerRuntimeStateImpl(null, "dev"))).toBe(true);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeArgvSpawner(() => ({ stdout: "", exitCode: 0 })),
      ),
    ),
  );
});

describe("ensureWindowsPathReleasedImpl", () => {
  const releaseSpawner = (shOutput: { readonly stdout: string; readonly exitCode: number }) =>
    makeArgvSpawner((argv) =>
      argv.includes("wslpath")
        ? { stdout: "/mnt/c/Users/test/AppData/Local/Programs/t3code\n", exitCode: 0 }
        : shOutput,
    );

  it.effect("reports released when no Linux process holds the path", () =>
    Effect.gen(function* () {
      const result = yield* ensureWindowsPathReleasedImpl({
        distro: "Ubuntu",
        windowsPath: "C:\\Users\\test\\AppData\\Local\\Programs\\t3code",
      });
      expect(result).toBe("released");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        releaseSpawner({ stdout: "RELEASED\n", exitCode: 0 }),
      ),
    ),
  );

  it.effect("reports busy when holders survive SIGTERM and SIGKILL", () =>
    Effect.gen(function* () {
      const result = yield* ensureWindowsPathReleasedImpl({
        distro: "Ubuntu",
        windowsPath: "C:\\Users\\test\\AppData\\Local\\Programs\\t3code",
      });
      expect(result).toBe("busy");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        releaseSpawner({ stdout: "BUSY 4242 4243\n", exitCode: 1 }),
      ),
    ),
  );

  it.effect("runs the holder scan as root so it can see and kill non-user-owned holders", () =>
    Effect.gen(function* () {
      // /proc/<pid>/{cwd,exe,fd,maps} are readable only by the process owner
      // and root, so an unprivileged scan is blind to holders owned by other
      // users (e.g. a root process with cwd in the install dir) and would
      // wrongly report RELEASED. The probe must run as root.
      const scanArgvs: string[][] = [];
      const result = yield* ensureWindowsPathReleasedImpl({
        distro: "Ubuntu",
        windowsPath: "C:\\Users\\test\\AppData\\Local\\Programs\\t3code",
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeArgvSpawner((argv) => {
            if (argv.includes("wslpath")) {
              return { stdout: "/mnt/c/Users/test/AppData/Local/Programs/t3code\n", exitCode: 0 };
            }
            scanArgvs.push([...argv]);
            return { stdout: "RELEASED\n", exitCode: 0 };
          }),
        ),
      );
      expect(result).toBe("released");
      expect(scanArgvs).toHaveLength(1);
      const argv = scanArgvs[0]!;
      const separator = argv.indexOf("--");
      const userFlag = argv.indexOf("-u");
      // `-u root` must appear before the `--` command separator.
      expect(userFlag).toBeGreaterThanOrEqual(0);
      expect(argv[userFlag + 1]).toBe("root");
      expect(userFlag).toBeLessThan(separator);
    }),
  );

  it.effect("reports unknown when the release-check spawn fails against a reachable distro", () =>
    Effect.gen(function* () {
      // wslpath just succeeded, so the distro was reachable moments ago — a
      // release-script spawn failure must read as "unverified" (abort), not
      // as "WSL is gone".
      const result = yield* ensureWindowsPathReleasedImpl({
        distro: "Ubuntu",
        windowsPath: "C:\\Users\\test\\AppData\\Local\\Programs\\t3code",
      });
      expect(result).toBe("unknown");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const argv = command._tag === "StandardCommand" ? [command.command, ...command.args] : [];
          if (argv.includes("wslpath")) {
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.make(encoder.encode("/mnt/c/install\n")),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcessSpawner",
              method: "spawn",
              pathOrDescriptor: "wsl.exe",
              description: "wsl.exe missing",
            }),
          );
        }),
      ),
    ),
  );

  it.effect("reports unknown when the path cannot be translated", () =>
    Effect.gen(function* () {
      const result = yield* ensureWindowsPathReleasedImpl({
        distro: null,
        windowsPath: "C:\\install",
      });
      expect(result).toBe("unknown");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeArgvSpawner((argv) =>
          argv.includes("wslpath") ? { stdout: "", exitCode: 1 } : { stdout: "", exitCode: 0 },
        ),
      ),
    ),
  );

  it("kills before scanning again and excludes itself from the holder scan", () => {
    const script = buildEnsurePathReleasedScript("'/mnt/c/install dir'");
    expect(script).toContain("cd /");
    expect(script).toContain('[ "$pid" = "$self" ] && continue');
    expect(script).toContain("kill $holders");
    expect(script).toContain("kill -9 $holders");
    expect(script.indexOf("kill $holders")).toBeLessThan(script.indexOf("kill -9 $holders"));
  });
});
