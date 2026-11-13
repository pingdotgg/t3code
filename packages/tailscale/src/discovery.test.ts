import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import type * as NodeOS from "node:os";

import {
  readTailscaleSshEnabledForDiscovery,
  readTailscaleStatusForDiscovery,
  TailscaleHost,
} from "./discovery.ts";

const entry = (address: string): NodeOS.NetworkInterfaceInfo =>
  address.includes(":")
    ? {
        address,
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: `${address}/64`,
        scopeid: 0,
      }
    : {
        address,
        netmask: "255.255.255.255",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: `${address}/32`,
      };

// WARP comes first and shares Tailscale's IPv4 range; only Tailscale has the fd7a address.
const WARP = { utun3: [entry("100.96.0.1"), entry("2606:4700:110::1")] };
const TAILSCALE = { utun4: [entry("100.64.1.2"), entry("fd7a:115c:a1e0::1")] };

const CLI_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "from-cli.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});

const read = (input: {
  readonly platform: NodeJS.Platform;
  readonly interfaces: ReturnType<typeof NodeOS.networkInterfaces>;
  readonly tailscaledSocket?: boolean;
  readonly names?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const spawns = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make(() =>
      Effect.as(
        Ref.update(spawns, (count) => count + 1),
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(CLI_STATUS)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    const [status, sshEnabled] = yield* Effect.all([
      readTailscaleStatusForDiscovery,
      readTailscaleSshEnabledForDiscovery,
    ]).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HostProcess.Platform, input.platform),
          Layer.succeed(TailscaleHost, {
            networkInterfaces: () => input.interfaces,
            hasTailscaledSocket: () => input.tailscaledSocket === true,
            lookupMagicDnsName: (address) => Effect.succeed(input.names?.[address] ?? null),
          }),
        ),
      ),
    );
    return { status, sshEnabled, spawns: yield* Ref.get(spawns) };
  });

describe("Tailscale discovery", () => {
  it.effect("reads the macOS app's interface instead of starting its CLI", () =>
    Effect.gen(function* () {
      const result = yield* read({
        platform: "darwin",
        interfaces: { ...WARP, ...TAILSCALE },
        names: { "100.64.1.2": "bb-1.tail1234.ts.net", "100.96.0.1": "warp.example" },
      });
      assert.deepStrictEqual(result, {
        status: {
          running: true,
          magicDnsName: "bb-1.tail1234.ts.net",
          tailnetIpv4Addresses: ["100.64.1.2"],
          httpsServeEnabled: null,
        },
        sshEnabled: false,
        spawns: 0,
      });
    }),
  );

  it.effect("reports Tailscale as stopped when only another VPN holds its IPv4 range", () =>
    Effect.gen(function* () {
      const result = yield* read({
        platform: "darwin",
        interfaces: WARP,
        names: { "100.96.0.1": "warp.example" },
      });
      assert.strictEqual(result.status.running, false);
      assert.strictEqual(result.status.magicDnsName, null);
      assert.deepStrictEqual(result.status.tailnetIpv4Addresses, []);
      assert.strictEqual(result.spawns, 0);
    }),
  );

  it.effect("asks the CLI where it is not the macOS app's", () =>
    Effect.gen(function* () {
      for (const host of [
        { platform: "darwin", tailscaledSocket: true },
        { platform: "linux" },
      ] as const) {
        const result = yield* read({ ...host, interfaces: TAILSCALE });
        assert.strictEqual(result.status.magicDnsName, "from-cli.tail1234.ts.net");
        assert.strictEqual(result.spawns, 2);
      }
    }),
  );
});
