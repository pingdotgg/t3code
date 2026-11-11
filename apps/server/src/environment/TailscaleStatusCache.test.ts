// @effect-diagnostics nodeBuiltinImport:off -- replace the native OS lookup and sync its ESM bindings.
import * as NodeModule from "node:module";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as NodeOS from "node:os";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import * as TailscaleStatusCache from "./TailscaleStatusCache.ts";

afterEach(() => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
});

const encoder = new TextEncoder();
const nodeOs: typeof NodeOS = NodeModule.createRequire(import.meta.url)("node:os");

const useTailnetAddress = (address: string) =>
  Effect.sync(() => {
    vi.spyOn(nodeOs, "networkInterfaces").mockReturnValue({
      tailscale0: [
        {
          address,
          netmask: "255.255.255.255",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: `${address}/32`,
        },
      ],
    });
    NodeModule.syncBuiltinESMExports();
  });

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

const STATUS_UP: CommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
  }),
};
const STATUS_DOWN: CommandResult = { exitCode: 1, stdout: "" };
const prefs = (RunSSH: boolean): CommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ RunSSH, WantRunning: true }),
});

const makeTailscale = (platform: NodeJS.Platform, initial: { status: CommandResult }) => {
  const tailscale = { status: initial.status, prefs: prefs(true) };
  const spawned = { status: 0, prefs: 0 };
  const spawner = ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    const isPrefs = args[0] === "debug";
    spawned[isPrefs ? "prefs" : "status"]++;
    const result = isPrefs ? tailscale.prefs : tailscale.status;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(result.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const layer = TailscaleStatusCache.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HostProcess.Platform, platform),
      ),
    ),
  );
  return { tailscale, spawned, layer };
};

const readBoth = Effect.gen(function* () {
  const cache = yield* TailscaleStatusCache.TailscaleStatusCache;
  const magicDnsName = yield* cache.readStatus().pipe(
    Effect.map((status) => status.magicDnsName),
    Effect.orElseSucceed(() => null),
  );
  const sshEnabled = yield* cache.readSshEnabled();
  return { magicDnsName, sshEnabled };
});

describe("TailscaleStatusCache", () => {
  it.effect("on macOS keeps a read until the tailnet addresses change", () => {
    const { spawned, layer } = makeTailscale("darwin", { status: STATUS_UP });
    return Effect.gen(function* () {
      yield* useTailnetAddress("100.64.1.2");
      for (let connect = 0; connect < 3; connect++) {
        expect(yield* readBoth).toEqual({ magicDnsName: "bb-1.tail1234.ts.net", sshEnabled: true });
        yield* TestClock.adjust("2 minutes");
      }
      expect(spawned).toEqual({ status: 1, prefs: 1 });

      yield* useTailnetAddress("100.64.1.3");
      yield* readBoth;
      expect(spawned).toEqual({ status: 2, prefs: 2 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("on macOS retries a failed read after a minute", () => {
    const { tailscale, spawned, layer } = makeTailscale("darwin", { status: STATUS_DOWN });
    return Effect.gen(function* () {
      expect((yield* readBoth).magicDnsName).toBeNull();
      tailscale.status = STATUS_UP;
      expect((yield* readBoth).magicDnsName).toBeNull();
      expect(spawned.status).toBe(1);

      yield* TestClock.adjust("61 seconds");
      expect((yield* readBoth).magicDnsName).toBe("bb-1.tail1234.ts.net");
      expect(spawned.status).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("outside macOS reads a Tailscale SSH change on the next read", () => {
    const { tailscale, layer } = makeTailscale("linux", { status: STATUS_UP });
    return Effect.gen(function* () {
      yield* useTailnetAddress("100.64.1.2");
      expect((yield* readBoth).sshEnabled).toBe(true);
      tailscale.prefs = prefs(false);
      expect((yield* readBoth).sshEnabled).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
