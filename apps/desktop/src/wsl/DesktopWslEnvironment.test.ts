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
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  buildWslNodeEnvPreamble,
  DesktopWslDistroListError,
  formatMissingToolsReason,
  formatNodePtyProbeFailureReason,
  formatWslShellTransportFailureReason,
  getDistroIpImpl,
  parseNodePath,
  parseNodeVersion,
  parseResolvedPath,
  parseSingleWslHostnameAddress,
  parseToolchainReport,
  parseWslRouteSource,
  probeWslDistros,
} from "./DesktopWslEnvironment.ts";

const encoder = new TextEncoder();

type SpawnResult = { readonly stdout?: string; readonly exitCode?: number };

const makeProcessHandle = (result: SpawnResult) =>
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
  });

const makeDistroListSpawner = (result: SpawnResult) =>
  ChildProcessSpawner.make(() => Effect.succeed(makeProcessHandle(result)));

const makeCommandSpawner = (
  commands: ChildProcess.Command[],
  handler: (command: ChildProcess.Command) => SpawnResult,
) =>
  ChildProcessSpawner.make((command) => {
    commands.push(command);
    return Effect.succeed(makeProcessHandle(handler(command)));
  });

const commandParts = (command: ChildProcess.Command): ReadonlyArray<string> =>
  command._tag === "StandardCommand" ? [command.command, ...command.args] : [];

const ROUTE_COMMAND = ["wsl.exe", "-d", "Ubuntu", "--", "ip", "-4", "route", "get", "1.1.1.1"];

const HOSTNAME_COMMAND = ["wsl.exe", "-d", "Ubuntu", "--", "hostname", "-I"];

const isRouteCommand = (command: ChildProcess.Command): boolean =>
  commandParts(command).includes("route");

const isHostnameCommand = (command: ChildProcess.Command): boolean => {
  const parts = commandParts(command);
  return parts.at(-1) === "-I" || parts.at(-1) === "hostname -I";
};

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

describe("getDistroIpImpl", () => {
  it.effect("uses the route-selected src instead of the first hostname address", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = [];
      const spawner = makeCommandSpawner(commands, (command) => {
        if (isRouteCommand(command)) {
          return {
            stdout: "1.1.1.1 via 172.27.0.1 dev eth0 src 192.168.1.219 uid 1000 cache\n",
            exitCode: 0,
          };
        }
        if (isHostnameCommand(command)) {
          return {
            stdout: "172.22.0.1 172.19.0.1 172.17.0.1 192.168.1.219\n",
            exitCode: 0,
          };
        }
        return { exitCode: 1 };
      });

      const result = yield* getDistroIpImpl("Ubuntu").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      expect(Option.getOrUndefined(result)).toBe("192.168.1.219");
      expect(commands.map(commandParts)).toEqual([ROUTE_COMMAND]);
    }),
  );

  it.effect("falls back to the only hostname address when route lookup is unavailable", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = [];
      const spawner = makeCommandSpawner(commands, (command) => {
        if (isRouteCommand(command)) return { exitCode: 127 };
        if (isHostnameCommand(command)) return { stdout: "192.168.1.219\n", exitCode: 0 };
        return { exitCode: 1 };
      });

      const result = yield* getDistroIpImpl("Ubuntu").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      expect(Option.getOrUndefined(result)).toBe("192.168.1.219");
      expect(commands.map(commandParts)).toEqual([ROUTE_COMMAND, HOSTNAME_COMMAND]);
    }),
  );

  it.effect("returns none when the hostname fallback contains multiple addresses", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = [];
      const spawner = makeCommandSpawner(commands, (command) => {
        if (isRouteCommand(command)) return { stdout: "1.1.1.1 dev eth0\n", exitCode: 0 };
        if (isHostnameCommand(command)) {
          return {
            stdout: "172.22.0.1 172.19.0.1 172.17.0.1 192.168.1.219\n",
            exitCode: 0,
          };
        }
        return { exitCode: 1 };
      });

      const result = yield* getDistroIpImpl("Ubuntu").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      expect(Option.isNone(result)).toBe(true);
      expect(commands.map(commandParts)).toEqual([ROUTE_COMMAND, HOSTNAME_COMMAND]);
    }),
  );

  it.effect("rejects invalid IPv4 octets in route and hostname output", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.Command[] = [];
      const spawner = makeCommandSpawner(commands, (command) => {
        if (isRouteCommand(command)) {
          return { stdout: "1.1.1.1 dev eth0 src 999.999.999.999\n", exitCode: 0 };
        }
        if (isHostnameCommand(command)) return { stdout: "999.999.999.999\n", exitCode: 0 };
        return { exitCode: 1 };
      });

      const result = yield* getDistroIpImpl("Ubuntu").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      expect(Option.isNone(result)).toBe(true);
      expect(commands.map(commandParts)).toEqual([ROUTE_COMMAND, HOSTNAME_COMMAND]);
    }),
  );

  it.effect("uses one total timeout and does not start the fallback after it expires", () => {
    const commands: ChildProcess.Command[] = [];
    const spawner = makeCommandSpawner(commands, () => ({}));
    const layer = Layer.merge(
      TestClock.layer(),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return Effect.gen(function* () {
      const fiber = yield* getDistroIpImpl("Ubuntu").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(6));
      const result = yield* Fiber.join(fiber);

      expect(Option.isNone(result)).toBe(true);
      expect(commands.map(commandParts)).toEqual([ROUTE_COMMAND]);
    }).pipe(Effect.provide(layer));
  });
});

describe("WSL IPv4 parsing", () => {
  it("extracts the exact route src token and ignores gateway and suffix fields", () => {
    const result = parseWslRouteSource(
      "1.1.1.1 via 172.27.0.1 dev eth0 src 192.168.1.219 uid 1000 cache\n",
    );

    expect(Option.getOrUndefined(result)).toBe("192.168.1.219");
  });

  it("does not treat prefsrc as a route src token", () => {
    expect(Option.isNone(parseWslRouteSource("1.1.1.1 dev eth0 prefsrc 192.168.1.219"))).toBe(true);
  });

  it("rejects missing and malformed route sources", () => {
    expect(Option.isNone(parseWslRouteSource("1.1.1.1 dev eth0"))).toBe(true);
    expect(Option.isNone(parseWslRouteSource("1.1.1.1 dev eth0 src not-an-ip"))).toBe(true);
    expect(Option.isNone(parseWslRouteSource("1.1.1.1 dev eth0 src 256.1.1.1"))).toBe(true);
  });

  it("accepts one valid hostname address", () => {
    expect(Option.getOrUndefined(parseSingleWslHostnameAddress("  192.168.1.219\n"))).toBe(
      "192.168.1.219",
    );
  });

  it("rejects ambiguous hostname address output", () => {
    expect(
      Option.isNone(
        parseSingleWslHostnameAddress("172.22.0.1 172.19.0.1 172.17.0.1 192.168.1.219\n"),
      ),
    ).toBe(true);
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
