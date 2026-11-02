import { EnvironmentId, type TailnetPeerEnvironment } from "@t3tools/contracts";
import { readT3EnvironmentId } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";

/** Every box `t3 up` sets up listens here, and the desktop app does when sign-in is on. */
const PROBE_PORT = ServerConfig.DEFAULT_PORT;
const PROBE_TIMEOUT = Duration.millis(1_500);
const PROBE_CONCURRENCY = 4;
const RESULT_TTL = Duration.minutes(3);

const isEnvironmentId = Schema.is(EnvironmentId);

/** T3 Code environments among this host's tailnet peers, for clients that cannot list peers. */
export class TailnetPeers extends Context.Service<
  TailnetPeers,
  {
    /** Probes online peers the owner owns or that are tagged, a few at a time; cached for minutes. */
    readonly list: Effect.Effect<ReadonlyArray<TailnetPeerEnvironment>>;
  }
>()("t3/environment/TailnetPeers") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* TailscaleHost.TailscaleHost;
  const httpClient = yield* HttpClient.HttpClient;

  const discover = Effect.gen(function* () {
    const status = yield* host.status;
    if (status.backendState !== "Running") return [];
    const owner = TailscaleHost.tailnetOwnerUserId(status, config.tailscaleOwnerUserId);
    // Nodes shared in from other tailnets belong to someone else.
    const candidates = status.peers.flatMap((peer) => {
      const address = peer.tailnetIpv4Addresses[0];
      const owned = peer.tags.length > 0 || (owner !== null && peer.userId === owner);
      return peer.online && !peer.sharedIn && owned && address !== undefined
        ? [{ peer, address }]
        : [];
    });
    const found = yield* Effect.forEach(
      candidates,
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
    Effect.withSpan("TailnetPeers.discover"),
  );
  // A failed read is not kept, so the next request asks Tailscale again.
  const cached = yield* Effect.cachedWithTTL(discover, (exit) =>
    Exit.isSuccess(exit) ? RESULT_TTL : Duration.zero,
  );

  return TailnetPeers.of({
    list: host.inUse.pipe(
      Effect.flatMap((inUse) => (inUse ? cached : Effect.succeed([]))),
      // Tailscale being down is an empty tailnet, not a failure for the phone.
      Effect.orElseSucceed((): ReadonlyArray<TailnetPeerEnvironment> => []),
    ),
  });
});

export const layer = Layer.effect(TailnetPeers, make);
