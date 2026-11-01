import { describe, expect, it } from "@effect/vitest";
import type { TailscalePeer, TailscaleStatus } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import * as DesktopTailscaleStatus from "./DesktopTailscaleStatus.ts";
import { tailnetProbeCandidates } from "./DesktopTailscaleStatus.ts";

const peer = (name: string, overrides: Partial<TailscalePeer>): TailscalePeer => ({
  stableNodeId: name,
  hostName: name,
  magicDnsName: `${name}.tail1234.ts.net`,
  os: "linux",
  tailnetIpv4Addresses: [`100.88.1.${name.length}`],
  tailnetIpv6Addresses: [],
  userId: "owner",
  tags: [],
  sharedIn: false,
  online: true,
  lastSeen: null,
  keyExpired: false,
  active: false,
  curAddr: null,
  relay: null,
  peerRelay: null,
  ...overrides,
});

describe("tailnetProbeCandidates", () => {
  it("probes online peers this user owns or that are tagged, never shared-in ones", () => {
    const status = {
      backendState: "Running",
      selfUserId: "owner",
      peers: [
        peer("studio", {}),
        peer("server", { userId: null, tags: ["tag:server"] }),
        peer("asleep", { online: false }),
        peer("friend", { userId: "friend" }),
        peer("shared", { sharedIn: true }),
      ],
    } as unknown as TailscaleStatus;

    expect(tailnetProbeCandidates(status).map(({ peer }) => peer.hostName)).toEqual([
      "studio",
      "server",
    ]);
    expect(tailnetProbeCandidates({ ...status, backendState: "NeedsLogin" })).toEqual([]);
  });
});

describe("DesktopTailscaleStatus.discoverEnvironments", () => {
  it.effect("runs no CLI off the tailnet and reads status once a minute on it", () => {
    const interfaces: Record<
      string,
      readonly DesktopNetworkInterfaces.DesktopNetworkInterfaceInfo[] | undefined
    > = { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] };
    let statusReads = 0;
    const statusJson = JSON.stringify({
      BackendState: "Running",
      Self: { UserID: 7, TailscaleIPs: ["100.90.1.2"] },
      Peer: { a: { ID: "nStudio", UserID: 7, TailscaleIPs: ["100.88.1.2"], Online: true } },
    });
    const layer = DesktopTailscaleStatus.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopNetworkInterfaces.DesktopNetworkInterfaces, {
            read: Effect.succeed(interfaces),
          }),
          DesktopAppSettings.layerTest(),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.sync(() => {
                statusReads += 1;
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.make(new TextEncoder().encode(statusJson)),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                });
              }),
            ),
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ environmentId: "studio" })),
              ),
            ),
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const tailscale = yield* DesktopTailscaleStatus.DesktopTailscaleStatus;
      expect(yield* tailscale.discoverEnvironments).toEqual([]);
      expect(statusReads).toBe(0);

      interfaces.tailscale0 = [{ address: "100.90.1.2", family: "IPv4", internal: false }];
      expect((yield* tailscale.discoverEnvironments).map((found) => found.tailnetIpv4)).toEqual([
        "100.88.1.2",
      ]);
      yield* tailscale.discoverEnvironments;
      expect(statusReads).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
