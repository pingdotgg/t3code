import { it } from "@effect/vitest";
import {
  HostProcessHostname,
  HostProcessPlatform,
  HostProcessUsername,
} from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";

const encoder = new TextEncoder();

const TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

// What a tailscale CLI without `tailscale get` (older than 1.102) returns.
const TAILSCALE_GET_UNSUPPORTED: CommandResult = { exitCode: 1, stdout: "" };

/**
 * Spawner that answers `tailscale get` with `get` and every other command
 * (`tailscale status --json`) with `status`, recording each subcommand it
 * starts in `spawned`. With `stall`, the first command never exits and
 * completes `stall` once it has started.
 */
const spawnerLayer = (input: {
  readonly status: CommandResult;
  readonly get: CommandResult;
  readonly spawned: Array<string>;
  readonly stall: Deferred.Deferred<void> | undefined;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
        input.spawned.push(args[0] ?? "");
        const result = args[0] === "get" ? input.get : input.status;
        const stall = input.spawned.length === 1 ? input.stall : undefined;
        if (stall !== undefined) {
          yield* Deferred.succeed(stall, undefined);
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            stall !== undefined
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(result.stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

const netLayer = (input: { readonly ipv4: boolean; readonly ipv6: boolean }) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: (_port, host) => Effect.succeed(host === "::1" ? input.ipv6 : input.ipv4),
    reserveLoopbackPort: () => Effect.succeed(40_000),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });

interface MachineInput {
  readonly sshd: { readonly ipv4: boolean; readonly ipv6: boolean };
  readonly tailscale: CommandResult;
  readonly hostname: string;
  /** `tailscale get --json ssh`; omitted, the CLI predates `tailscale get`. */
  readonly tailscaleSsh?: boolean;
  readonly username?: string | undefined;
  readonly platform?: NodeJS.Platform;
  /** Collects the tailscale subcommands the resolver starts. */
  readonly spawned?: Array<string>;
  /** Holds the first tailscale command open; completed once it starts. */
  readonly stall?: Deferred.Deferred<void>;
}

/** Runs `program` against one RemoteOpenTargets built for the given machine. */
const onMachine = <A, E>(
  input: MachineInput,
  program: Effect.Effect<A, E, RemoteOpenTargets.RemoteOpenTargets>,
) =>
  program.pipe(
    Effect.provideService(HostProcessHostname, input.hostname),
    Effect.provideService(HostProcessUsername, "username" in input ? input.username : "theo"),
    Effect.provideService(HostProcessPlatform, input.platform ?? "linux"),
    Effect.provide(
      RemoteOpenTargets.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            netLayer(input.sshd),
            spawnerLayer({
              status: input.tailscale,
              get:
                input.tailscaleSsh === undefined
                  ? TAILSCALE_GET_UNSUPPORTED
                  : { exitCode: 0, stdout: JSON.stringify({ ssh: input.tailscaleSsh }) },
              spawned: input.spawned ?? [],
              stall: input.stall,
            }),
          ),
        ),
      ),
    ),
  );

const resolveTargets = (input: MachineInput) =>
  onMachine(
    input,
    Effect.flatMap(RemoteOpenTargets.RemoteOpenTargets, (service) => service.resolveTargets()),
  );

const TAILSCALE_UP = { exitCode: 0, stdout: TAILSCALE_STATUS_JSON };
const TAILSCALE_DOWN = { exitCode: 1, stdout: "" };
const NO_SSHD = { ipv4: false, ipv6: false };

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

  it.effect("advertises the tailnet name with this account when only Tailscale SSH answers", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: NO_SSHD,
        tailscale: TAILSCALE_UP,
        tailscaleSsh: true,
        hostname: "bb-1",
      });
      // No mDNS name: Tailscale SSH does not answer on the LAN address.
      expect(targets).toEqual([
        { kind: "tailscale-ssh", host: "bb-1.tail1234.ts.net", user: "theo" },
      ]);
    }),
  );

  it.effect("advertises nothing without sshd when Tailscale SSH is off", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: NO_SSHD,
        tailscale: TAILSCALE_UP,
        tailscaleSsh: false,
        hostname: "bb-1",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("advertises nothing for Tailscale SSH without a MagicDNS name", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: NO_SSHD,
        tailscale: TAILSCALE_DOWN,
        tailscaleSsh: true,
        hostname: "bb-1",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("does not start the tailscale CLI for Tailscale SSH on Windows hosts", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = [];
      const targets = yield* resolveTargets({
        sshd: NO_SSHD,
        tailscale: TAILSCALE_UP,
        tailscaleSsh: true,
        hostname: "bb-1",
        platform: "win32",
        spawned,
      });
      expect(targets).toEqual([]);
      expect(spawned).toEqual([]);
    }),
  );

  // A client that disconnects mid-discovery interrupts its own config load.
  // The next load, from any client, must still get a real answer.
  it.effect("answers the next config load after one is cut off mid-discovery", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = [];
      const stall = yield* Deferred.make<void>();
      yield* onMachine(
        {
          sshd: NO_SSHD,
          tailscale: TAILSCALE_UP,
          tailscaleSsh: true,
          hostname: "bb-1",
          spawned,
          stall,
        },
        Effect.gen(function* () {
          const service = yield* RemoteOpenTargets.RemoteOpenTargets;
          const cutOff = yield* Effect.forkChild(service.resolveTargets());
          yield* Deferred.await(stall);
          yield* Fiber.interrupt(cutOff);

          expect(yield* service.resolveTargets()).toEqual([
            { kind: "tailscale-ssh", host: "bb-1.tail1234.ts.net", user: "theo" },
          ]);
          expect(spawned.toSorted()).toEqual(["get", "get", "status", "status"]);
        }),
      );
    }),
  );

  it.effect("leaves out an account name a link cannot carry", () =>
    Effect.gen(function* () {
      for (const username of [undefined, "-oProxyCommand=calc", "DOMAIN\\theo"]) {
        const targets = yield* resolveTargets({
          sshd: NO_SSHD,
          tailscale: TAILSCALE_UP,
          tailscaleSsh: true,
          hostname: "bb-1",
          username,
        });
        expect(targets).toEqual([{ kind: "tailscale-ssh", host: "bb-1.tail1234.ts.net" }]);
      }
    }),
  );

  // Tailscale SSH also answers the tailnet name when sshd runs, but those
  // targets predate it; they stay exactly as older servers advertised them,
  // from the same single `tailscale status` call.
  it.effect("keeps sshd targets unchanged when Tailscale SSH is also on", () =>
    Effect.gen(function* () {
      const spawned: Array<string> = [];
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: false },
        tailscale: TAILSCALE_UP,
        tailscaleSsh: true,
        hostname: "bb-1",
        spawned,
      });
      expect(targets).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net" },
        { kind: "mdns", host: "bb-1.local" },
      ]);
      expect(spawned).toEqual(["status"]);
    }),
  );
});
