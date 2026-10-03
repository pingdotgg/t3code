import { it } from "@effect/vitest";
import { HostProcessHostname } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";

const encoder = new TextEncoder();

const TAILSCALE_STATUS_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});
// `tailscale down` keeps the node name in the status output but nothing answers on it.
const TAILSCALE_STOPPED_STATUS_JSON = JSON.stringify({
  BackendState: "Stopped",
  Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Spawner answering `tailscale status --json` and `tailscale debug prefs` separately. */
const spawnerLayer = (input: { readonly status: CommandResult; readonly prefs?: CommandResult }) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      const result = args[0] === "debug" ? (input.prefs ?? TAILSCALE_PREFS_NO_SSH) : input.status;
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

const netLayer = (input: { readonly ipv4: boolean; readonly ipv6: boolean }) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: (_port, host) => Effect.succeed(host === "::1" ? input.ipv6 : input.ipv4),
    reserveLoopbackPort: () => Effect.succeed(40_000),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });

const resolveTargets = (input: {
  readonly sshd: { readonly ipv4: boolean; readonly ipv6: boolean };
  readonly tailscale: { readonly status: CommandResult; readonly prefs?: CommandResult };
  readonly hostname: string;
}) =>
  Effect.flatMap(RemoteOpenTargets.RemoteOpenTargets, (service) => service.resolveTargets()).pipe(
    Effect.provideService(HostProcessHostname, input.hostname),
    Effect.provide(
      RemoteOpenTargets.layer.pipe(
        Layer.provide(Layer.mergeAll(netLayer(input.sshd), spawnerLayer(input.tailscale))),
      ),
    ),
  );

// `tailscale debug prefs` as printed by tailscale 1.94 (trimmed); RunSSH is the SSH switch.
const TAILSCALE_PREFS_NO_SSH = {
  exitCode: 0,
  stdout:
    '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": false,\n\t"WantRunning": true\n}\n',
};
const TAILSCALE_PREFS_SSH = {
  exitCode: 0,
  stdout:
    '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": true,\n\t"WantRunning": true\n}\n',
};
const TAILSCALE_UP = { status: { exitCode: 0, stdout: TAILSCALE_STATUS_JSON } };
const TAILSCALE_SSH = { status: TAILSCALE_UP.status, prefs: TAILSCALE_PREFS_SSH };
const TAILSCALE_DOWN = { status: { exitCode: 1, stdout: "" }, prefs: { exitCode: 1, stdout: "" } };

describe("RemoteOpenTargets", () => {
  it.effect("advertises nothing when no sshd accepts on either loopback", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: TAILSCALE_UP,
        hostname: "bb-1",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("advertises the tailnet name alone when only Tailscale SSH is serving", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: TAILSCALE_SSH,
        hostname: "bb-1",
      });
      expect(targets).toEqual([{ kind: "tailscale", host: "bb-1.tail1234.ts.net" }]);
    }),
  );

  it.effect("ignores the SSH pref while tailscale is down", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: { status: TAILSCALE_DOWN.status, prefs: TAILSCALE_PREFS_SSH },
        hostname: "bb-1",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("does not advertise a stopped daemon's name even with SSH enabled", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: {
          status: { exitCode: 0, stdout: TAILSCALE_STOPPED_STATUS_JSON },
          prefs: TAILSCALE_PREFS_SSH,
        },
        hostname: "bb-1",
      });
      expect(targets).toEqual([]);
      const withSshd = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: false },
        tailscale: { status: { exitCode: 0, stdout: TAILSCALE_STOPPED_STATUS_JSON } },
        hostname: "bb-1",
      });
      expect(withSshd).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );

  it.effect("orders the tailnet name before the mDNS name", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: true },
        tailscale: TAILSCALE_UP,
        hostname: "bb-1",
      });
      expect(targets).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net" },
        { kind: "mdns", host: "bb-1.local" },
      ]);
    }),
  );

  it.effect("accepts an sshd bound to IPv6 loopback only", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: true },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );

  it.effect("falls back to mDNS alone when tailscale is unavailable", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: false },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );

  it.effect("shortens an FQDN hostname to its first label for mDNS", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: true },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1.example.com",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );
});
