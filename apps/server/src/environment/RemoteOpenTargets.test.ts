// @effect-diagnostics nodeBuiltinImport:off -- replace the native OS lookup and sync its ESM bindings.
import * as NodeModule from "node:module";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as NodeOS from "node:os";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";
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

const TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

const layerSpawner = (
  input: { readonly status: CommandResult; readonly prefs: CommandResult },
  spawnedArgs?: Array<ReadonlyArray<string>>,
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      spawnedArgs?.push(args);
      const result = args[0] === "debug" ? input.prefs : input.status;
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
    }),
  );

const layerNet = (input: { readonly ipv4: boolean; readonly ipv6: boolean }) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: (_port, host) => Effect.succeed(host === "::1" ? input.ipv6 : input.ipv4),
    reserveLoopbackPort: () => Effect.succeed(40_000),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });

const layerTargets = (
  sshd: { readonly ipv4: boolean; readonly ipv6: boolean },
  spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  platform: NodeJS.Platform = "linux",
) =>
  RemoteOpenTargets.layer.pipe(
    Layer.provide(layerNet(sshd)),
    Layer.provide(
      TailscaleStatusCache.layer.pipe(
        Layer.provide(Layer.mergeAll(spawner, Layer.succeed(HostProcess.Platform, platform))),
      ),
    ),
  );

const resolveTargets = (input: {
  readonly sshd: { readonly ipv4: boolean; readonly ipv6: boolean };
  readonly tailscale: { readonly status: CommandResult; readonly prefs: CommandResult };
  readonly hostname: string;
  readonly username?: string | null;
}) => {
  const resolve = Effect.flatMap(RemoteOpenTargets.RemoteOpenTargets, (service) =>
    service.resolveTargets(),
  ).pipe(
    Effect.provideService(HostProcess.Hostname, input.hostname),
    Effect.provide(layerTargets(input.sshd, layerSpawner(input.tailscale))),
  );

  return input.username === undefined
    ? resolve
    : resolve.pipe(Effect.provideService(HostProcess.Username, input.username));
};

const prefsJson = (prefs: { readonly RunSSH: boolean; readonly WantRunning: boolean }) => ({
  exitCode: 0,
  stdout: JSON.stringify(
    { ControlURL: "https://controlplane.tailscale.com", ...prefs },
    null,
    "\t",
  ),
});

const STATUS_UP = { exitCode: 0, stdout: TAILSCALE_STATUS_JSON };
const TAILSCALE_UP = { status: STATUS_UP, prefs: prefsJson({ RunSSH: false, WantRunning: true }) };
const TAILSCALE_SSH = { status: STATUS_UP, prefs: prefsJson({ RunSSH: true, WantRunning: true }) };
const TAILSCALE_DOWN = { status: { exitCode: 1, stdout: "" }, prefs: { exitCode: 1, stdout: "" } };

describe("RemoteOpenTargets", () => {
  it.effect("advertises nothing when no sshd accepts and Tailscale SSH is off", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: TAILSCALE_UP,
        hostname: "bb-1",
        username: "t3-user",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("advertises only the tailnet name when Tailscale SSH serves without sshd", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: TAILSCALE_SSH,
        hostname: "bb-1",
        username: "t3-user",
      });
      expect(targets).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net", username: "t3-user" },
      ]);
    }),
  );

  it.effect("ignores a stored RunSSH after `tailscale down`", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: { status: STATUS_UP, prefs: prefsJson({ RunSSH: true, WantRunning: false }) },
        hostname: "bb-1",
        username: null,
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("on macOS keeps a Tailscale read until the tailnet addresses change", () => {
    const spawnedArgs: Array<ReadonlyArray<string>> = [];
    const spawned = () => ({
      status: spawnedArgs.filter((args) => args[0] === "status").length,
      debugPrefs: spawnedArgs.filter((args) => args[0] === "debug").length,
    });
    return Effect.gen(function* () {
      const service = yield* RemoteOpenTargets.RemoteOpenTargets;
      yield* useTailnetAddress("100.64.1.2");
      for (let connect = 0; connect < 3; connect++) {
        expect(yield* service.resolveTargets()).toEqual([
          { kind: "tailscale", host: "bb-1.tail1234.ts.net", username: "t3-user" },
        ]);
        yield* TestClock.adjust("2 minutes");
      }
      expect(spawned()).toEqual({ status: 1, debugPrefs: 1 });

      yield* useTailnetAddress("100.64.1.3");
      yield* service.resolveTargets();
      expect(spawned()).toEqual({ status: 2, debugPrefs: 2 });
    }).pipe(
      Effect.provideService(HostProcess.Hostname, "bb-1"),
      Effect.provideService(HostProcess.Username, "t3-user"),
      Effect.provide(
        layerTargets(
          { ipv4: false, ipv6: false },
          layerSpawner(TAILSCALE_SSH, spawnedArgs),
          "darwin",
        ),
      ),
    );
  });

  it.effect("on macOS retries a failed Tailscale read after a minute", () => {
    const spawnedArgs: Array<ReadonlyArray<string>> = [];
    const tailscale = { ...TAILSCALE_SSH, status: TAILSCALE_DOWN.status };
    const statusReads = () => spawnedArgs.filter((args) => args[0] === "status").length;
    return Effect.gen(function* () {
      const service = yield* RemoteOpenTargets.RemoteOpenTargets;
      expect(yield* service.resolveTargets()).toEqual([]);
      tailscale.status = STATUS_UP;
      expect(yield* service.resolveTargets()).toEqual([]);
      expect(statusReads()).toBe(1);

      yield* TestClock.adjust("61 seconds");
      expect(yield* service.resolveTargets()).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net", username: "t3-user" },
      ]);
      expect(statusReads()).toBe(2);
    }).pipe(
      Effect.provideService(HostProcess.Hostname, "bb-1"),
      Effect.provideService(HostProcess.Username, "t3-user"),
      Effect.provide(
        layerTargets({ ipv4: false, ipv6: false }, layerSpawner(tailscale, spawnedArgs), "darwin"),
      ),
    );
  });

  it.effect("outside macOS reads a Tailscale SSH change on the next resolve", () => {
    const tailscale = { ...TAILSCALE_SSH };
    return Effect.gen(function* () {
      const service = yield* RemoteOpenTargets.RemoteOpenTargets;
      yield* useTailnetAddress("100.64.1.2");
      expect(yield* service.resolveTargets()).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net", username: "t3-user" },
      ]);
      tailscale.prefs = prefsJson({ RunSSH: false, WantRunning: true });
      expect(yield* service.resolveTargets()).toEqual([]);
    }).pipe(
      Effect.provideService(HostProcess.Hostname, "bb-1"),
      Effect.provideService(HostProcess.Username, "t3-user"),
      Effect.provide(layerTargets({ ipv4: false, ipv6: false }, layerSpawner(tailscale))),
    );
  });

  it.effect("accepts an sshd bound to IPv6 loopback only", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: true },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1",
        username: "t3-user",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local", username: "t3-user" }]);
    }),
  );
});
