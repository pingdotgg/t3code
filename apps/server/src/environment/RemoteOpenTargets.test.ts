// @effect-diagnostics nodeBuiltinImport:off -- replace the native OS lookup and sync its ESM bindings.
import * as NodeModule from "node:module";
import type * as NodeOS from "node:os";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";

const mutableOs = NodeModule.createRequire(import.meta.url)("node:os") as typeof NodeOS;

afterEach(() => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
});

const encoder = new TextEncoder();

const TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

const layerSpawner = (input: { readonly status: CommandResult; readonly prefs: CommandResult }) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
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
    Effect.provide(
      RemoteOpenTargets.layer.pipe(
        Layer.provide(Layer.mergeAll(layerNet(input.sshd), layerSpawner(input.tailscale))),
      ),
    ),
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

  it.effect("orders the tailnet name before the mDNS name", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: true },
        tailscale: TAILSCALE_UP,
        hostname: "bb-1",
        username: "t3-user",
      });
      expect(targets).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net", username: "t3-user" },
        { kind: "mdns", host: "bb-1.local", username: "t3-user" },
      ]);
    }),
  );

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

  it.effect("falls back to mDNS alone when tailscale is unavailable", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: false },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1",
        username: "t3-user",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local", username: "t3-user" }]);
    }),
  );

  it.effect("shortens an FQDN hostname to its first label for mDNS", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: true },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1.example.com",
        username: "t3-user",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local", username: "t3-user" }]);
    }),
  );

  it.effect("still advertises hostname targets when the OS login lookup fails", () =>
    Effect.gen(function* () {
      const userInfo = vi.spyOn(mutableOs, "userInfo").mockImplementation(() => {
        throw new Error("No passwd entry for this UID");
      });
      NodeModule.syncBuiltinESMExports();
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: true },
        tailscale: TAILSCALE_UP,
        hostname: "bb-1",
      });
      expect(userInfo).toHaveBeenCalled();
      expect(targets).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net" },
        { kind: "mdns", host: "bb-1.local" },
      ]);
    }),
  );
});
