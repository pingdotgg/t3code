import { describe, expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as CliError from "effect/cli/CliError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as AutomaticPort from "./automaticPort.ts";

const WSL_KERNEL = "6.6.87.2-microsoft-standard-WSL2\n";
const NETSTAT_PATH = "/windows/c/Windows/System32/netstat.exe";

const output = (stdout: string, code: number | null = null): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code === null ? null : ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const listening = (ports: ReadonlyArray<number>, host = "127.0.0.1", foreign = "0.0.0.0:0") =>
  ports.map((port) => `  TCP    ${host}:${port}    ${foreign}    ABHÖREN    4242`).join("\r\n");

interface Scenario {
  readonly kernelRelease?: string;
  readonly windowsPorts?: ReadonlyArray<number>;
  readonly windowsPortsV6?: ReadonlyArray<number>;
  readonly tcpv6ExitCode?: number;
  readonly wslpathMissing?: boolean;
  readonly reservedPorts?: ReadonlyArray<number>;
}

const select = (scenario: Scenario) => {
  const commands: string[] = [];
  const reserved = [...(scenario.reservedPorts ?? [50_001])];
  const net: NetService.NetServiceShape = {
    canListenOnHost: () => Effect.succeed(true),
    hasListenerOnHost: () => Effect.succeed(false),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    reserveLoopbackPort: () => Effect.sync(() => reserved.shift() ?? 60_000),
    findAvailablePort: Effect.succeed,
  };
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    commands.push(input.command);
    if (input.command === "wslpath") {
      if (scenario.wslpathMissing) {
        return Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          }),
        );
      }
      return Effect.succeed(output(`${NETSTAT_PATH}\n`));
    }
    if (input.args.includes("tcpv6")) {
      return Effect.succeed(
        output(
          listening(scenario.windowsPortsV6 ?? [], "[::1]", "[::]:0"),
          scenario.tcpv6ExitCode ?? null,
        ),
      );
    }
    return Effect.succeed(output(listening(scenario.windowsPorts ?? [])));
  };
  const layer = Layer.mergeAll(
    Layer.succeed(NetService.NetService, net),
    Layer.succeed(ProcessRunner.ProcessRunner, { run }),
    FileSystem.layerNoop({
      readFileString: (path) =>
        path === "/proc/sys/kernel/osrelease" && scenario.kernelRelease !== undefined
          ? Effect.succeed(scenario.kernelRelease)
          : Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readFileString",
              }),
            ),
    }),
  );
  return Effect.gen(function* () {
    const selectAutomaticPort = yield* AutomaticPort.make;
    const port = yield* selectAutomaticPort(3773);
    return { port, commands };
  }).pipe(Effect.provide(layer));
};

describe("automatic port selection", () => {
  it.effect("moves off the default port only when Windows already listens on it", () =>
    Effect.gen(function* () {
      const free = yield* select({ kernelRelease: WSL_KERNEL, windowsPorts: [8080] });
      expect(free.port).toBe(3773);
      expect(free.commands).toEqual(["wslpath", NETSTAT_PATH, NETSTAT_PATH]);

      const owned = yield* select({ kernelRelease: WSL_KERNEL, windowsPorts: [3773] });
      expect(owned.port).toBe(50_001);
    }),
  );

  it.effect("retries a fallback port that Windows already listens on", () =>
    Effect.gen(function* () {
      const result = yield* select({
        kernelRelease: WSL_KERNEL,
        windowsPorts: [3773],
        windowsPortsV6: [50_001],
        reservedPorts: [50_001, 50_002],
      });
      expect(result.port).toBe(50_002);
    }),
  );

  it.effect("fails with an actionable error when every fallback belongs to Windows", () =>
    Effect.gen(function* () {
      const ports = Array.from({ length: 8 }, (_, index) => 50_001 + index);
      const error = yield* select({
        kernelRelease: WSL_KERNEL,
        windowsPorts: [3773],
        windowsPortsV6: ports,
        reservedPorts: ports,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(CliError.UserError);
      expect(error.cause).toContain("--port");
    }),
  );

  it.effect("keeps the local choice when the Windows snapshot is unavailable", () =>
    Effect.gen(function* () {
      const partial = yield* select({
        kernelRelease: WSL_KERNEL,
        windowsPorts: [3773],
        tcpv6ExitCode: 1,
      });
      expect(partial.port).toBe(3773);

      const noInterop = yield* select({ kernelRelease: WSL_KERNEL, wslpathMissing: true });
      expect(noInterop.port).toBe(3773);
    }),
  );

  it.effect("never queries Windows outside WSL", () =>
    Effect.gen(function* () {
      for (const scenario of [
        { kernelRelease: "6.8.0-45-generic\n" },
        // macOS and Windows have no kernel release file.
        {},
      ] satisfies ReadonlyArray<Scenario>) {
        const result = yield* select(scenario);
        expect(result.port).toBe(3773);
        expect(result.commands).toEqual([]);
      }
    }),
  );
});
