import {
  type DesktopTailscaleStatus as DesktopTailscaleStatusResult,
  EnvironmentId,
  type TailnetPeerEnvironment,
  tailscaleStateFromBackend,
} from "@t3tools/contracts";
import {
  isTailscaleIpv4Address,
  readT3EnvironmentId,
  readTailscaleStatus,
  type TailscaleCliUse,
  type TailscaleStatus,
  tailscaleStateOfReadError,
} from "@t3tools/tailscale";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";

const CACHE_TTL = Duration.seconds(60);
/** Where `t3 up` boxes and desktops with Tailscale sign-in listen. */
const PROBE_PORT = 3773;
const PROBE_TIMEOUT = Duration.millis(1_500);
const PROBE_CONCURRENCY = 4;

const isEnvironmentId = Schema.is(EnvironmentId);

/** This device's 100.64/10 addresses, sorted and joined. Empty while it is on no tailnet. */
const tailscaleIpv4AddressKey = (
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
): string =>
  [
    ...new Set(
      Object.values(networkInterfaces)
        .flatMap((addresses) => addresses ?? [])
        .filter(
          (address) =>
            !address.internal &&
            address.family === "IPv4" &&
            isTailscaleIpv4Address(address.address),
        )
        .map((address) => address.address),
    ),
  ]
    .toSorted()
    .join(",");

/**
 * Online peers this user owns or that are tagged. Nodes shared in from other
 * tailnets belong to someone else.
 */
export const tailnetProbeCandidates = (status: TailscaleStatus) =>
  status.backendState !== "Running"
    ? []
    : status.peers.flatMap((peer) => {
        const address = peer.tailnetIpv4Addresses[0];
        const owned =
          peer.tags.length > 0 || (status.selfUserId !== null && peer.userId === status.selfUserId);
        return peer.online && !peer.sharedIn && owned && address !== undefined
          ? [{ peer, address }]
          : [];
      });

export class DesktopTailscaleStatus extends Context.Service<
  DesktopTailscaleStatus,
  {
    /** This device's Tailscale, for connection diagnosis. Read only on request, never polled. */
    readonly read: Effect.Effect<DesktopTailscaleStatusResult>;
    /**
     * `tailscale status` for reads nobody asked for, or null when it fails.
     * Skips the macOS app bundle unless Serve or sign-in is on.
     */
    readonly status: Effect.Effect<TailscaleStatus | null>;
    /**
     * T3 Code environments among this device's tailnet peers. Probed here, not
     * in the renderer, so ports that are not T3 Code never see a browser fetch.
     */
    readonly discoverEnvironments: Effect.Effect<ReadonlyArray<TailnetPeerEnvironment>>;
  }
>()("@t3tools/desktop/backend/DesktopTailscaleStatus") {}

/** @public */
export const make = Effect.gen(function* () {
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  // Keyed by this device's tailnet addresses, so logging in or out reads again
  // while repeated checks skip macOS TCC prompts.
  const makeStatusCache = (use: TailscaleCliUse) =>
    Cache.make({
      capacity: 1,
      timeToLive: CACHE_TTL,
      lookup: (_addresses: string) =>
        Effect.all({
          read: Effect.result(readTailscaleStatus(use)),
          checkedAt: Effect.map(DateTime.now, DateTime.formatIso),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    });
  const statusCaches = {
    passive: yield* makeStatusCache("passive"),
    active: yield* makeStatusCache("active"),
  };
  const readCached = (use: TailscaleCliUse, addresses: string) =>
    Cache.get(statusCaches[use], addresses);
  const passiveUse = Effect.map(desktopSettings.get, (settings): TailscaleCliUse =>
    settings.tailscaleServeEnabled || settings.tailscaleSignInEnabled ? "active" : "passive",
  );
  const addressKey = Effect.map(networkInterfaces.read, tailscaleIpv4AddressKey);

  const status = Effect.gen(function* () {
    const { read } = yield* readCached(yield* passiveUse, yield* addressKey);
    return Result.getOrNull(read);
  });

  const read = Effect.gen(function* () {
    const { read, checkedAt } = yield* readCached("active", yield* addressKey);
    if (Result.isFailure(read)) {
      return { state: tailscaleStateOfReadError(read.failure), checkedAt, peers: [] };
    }
    return {
      state: tailscaleStateFromBackend(read.success.backendState),
      checkedAt,
      peers: read.success.peers.map((peer) => ({
        tailnetAddresses: peer.tailnetIpv4Addresses,
        magicDnsName: peer.magicDnsName,
        online: peer.online,
        lastSeen: peer.lastSeen,
        active: peer.active,
        curAddr: peer.curAddr,
        relay: peer.relay,
        peerRelay: peer.peerRelay,
      })),
    };
  }).pipe(Effect.withSpan("desktop.tailscaleStatus.read"));

  const discoverEnvironments = Effect.gen(function* () {
    // With no tailnet address no peer is reachable, so the CLI does not run.
    if ((yield* addressKey) === "") return [];
    const current = yield* status;
    if (current === null) return [];
    const found = yield* Effect.forEach(
      tailnetProbeCandidates(current),
      ({ peer, address }) =>
        readT3EnvironmentId({
          baseUrl: `http://${address}:${PROBE_PORT}`,
          timeout: PROBE_TIMEOUT,
        }).pipe(
          Effect.map((environmentId) =>
            Option.filter(environmentId, isEnvironmentId).pipe(
              Option.map((id): TailnetPeerEnvironment => ({
                name: peer.magicDnsName?.split(".")[0] || peer.hostName || address,
                magicDnsName: peer.magicDnsName,
                tailnetIpv4: address,
                environmentId: id,
              })),
            ),
          ),
        ),
      { concurrency: PROBE_CONCURRENCY },
    );
    return found.flatMap(Option.toArray);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.withSpan("desktop.tailscaleStatus.discoverEnvironments"),
  );

  return DesktopTailscaleStatus.of({ read, status, discoverEnvironments });
});

export const layer = Layer.effect(DesktopTailscaleStatus, make);
