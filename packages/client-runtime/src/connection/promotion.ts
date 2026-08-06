import type { AdvertisedEndpoint, EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders } from "../state/environmentHttpAuth.ts";
import type { PreparedConnection } from "./model.ts";

/** A direct route a relay-connected environment can be promoted to. */
export interface PromotedRoute {
  readonly endpointId: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

const ENDPOINTS_REQUEST_TIMEOUT_MS = 10_000;
const CANDIDATE_PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBED_CANDIDATES = 5;
/** After a promoted route fails, stay on the relay and do not re-promote that
 * endpoint until the cooldown expires. Keeps a flaky LAN from ping-ponging the
 * connection between routes. */
const PROMOTION_FAILURE_COOLDOWN_MS = 5 * 60_000;

const reachabilityRank: Record<AdvertisedEndpoint["reachability"], number> = {
  lan: 0,
  "private-network": 1,
  loopback: 2,
  public: 3,
};

function normalizedBaseUrl(rawValue: string): string | null {
  try {
    const url = new URL(rawValue);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Filter and rank advertised endpoints down to promotion candidates: reachable
 * direct endpoints (LAN or private network) that are not the route we are
 * already using and are not cooling down after a recent failure. Loopback is
 * excluded (it only ever reaches the server's own machine) and public
 * endpoints are excluded (promotion targets same-network or tailnet routes;
 * a public route is not obviously better than the relay).
 */
export function selectPromotionCandidates(input: {
  readonly endpoints: readonly AdvertisedEndpoint[];
  readonly currentHttpBaseUrl: string;
  readonly cooldownEndpointIds?: ReadonlySet<string>;
}): readonly AdvertisedEndpoint[] {
  const currentBaseUrl = normalizedBaseUrl(input.currentHttpBaseUrl);
  return input.endpoints
    .filter((endpoint) => {
      if (endpoint.status === "unavailable") return false;
      if (endpoint.reachability !== "lan" && endpoint.reachability !== "private-network") {
        return false;
      }
      if (input.cooldownEndpointIds?.has(endpoint.id)) return false;
      return normalizedBaseUrl(endpoint.httpBaseUrl) !== currentBaseUrl;
    })
    .sort(
      (left, right) => reachabilityRank[left.reachability] - reachabilityRank[right.reachability],
    )
    .slice(0, MAX_PROBED_CANDIDATES);
}

interface PromotionCooldown {
  readonly endpointId: string;
  readonly failedAtEpochMs: number;
}

/**
 * Discovers direct routes for relay-connected environments and remembers the
 * chosen route as a per-environment override. The relay connection broker
 * consults the override at prepare time and tries the direct route before
 * falling back to the managed relay tunnel; the supervisor runs `discover`
 * over the live session after a relay connection is established.
 */
export class ConnectionPromotion extends Context.Service<
  ConnectionPromotion,
  {
    /** Current route override for an environment, if a promotion is active. */
    readonly overrideFor: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PromotedRoute>>;
    /** Clears the override and starts the failure cooldown for its endpoint.
     * Called when connecting through the override failed and the connection
     * fell back to the relay. */
    readonly reportOverrideFailed: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** Fetches the environment's advertised endpoints over the connected
     * (typically relay-tunneled) session, probes direct candidates, verifies
     * they are the same environment, and stores the best one as the override.
     * Never fails; returns none when no direct route is usable. */
    readonly discover: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<PromotedRoute>>;
  }
>()("@t3tools/client-runtime/connection/promotion/ConnectionPromotion") {}

const fetchAdvertisedEndpoints = Effect.fn("clientRuntime.connection.promotion.fetchEndpoints")(
  function* (prepared: PreparedConnection, signer: ManagedRelay.ManagedRelayDpopSigner["Service"]) {
    const requestUrl = environmentEndpointUrl(prepared.httpBaseUrl, "/api/remote-access/endpoints");
    const headers = yield* buildEnvironmentAuthHeaders(
      prepared.httpAuthorization,
      "GET",
      requestUrl,
      Option.some(signer),
    );
    const client = yield* makeEnvironmentHttpApiClient(prepared.httpBaseUrl);
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      ENDPOINTS_REQUEST_TIMEOUT_MS,
      client.remoteAccess.advertisedEndpoints({ headers }),
    );
  },
);

export const make = Effect.gen(function* () {
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const httpClient = yield* HttpClient.HttpClient;
  const overrides = yield* Ref.make<ReadonlyMap<EnvironmentId, PromotedRoute>>(new Map());
  const cooldowns = yield* Ref.make<ReadonlyMap<EnvironmentId, PromotionCooldown>>(new Map());

  const overrideFor = Effect.fn("ConnectionPromotion.overrideFor")(function* (
    environmentId: EnvironmentId,
  ) {
    const override = (yield* Ref.get(overrides)).get(environmentId);
    return override === undefined ? Option.none<PromotedRoute>() : Option.some(override);
  });

  const reportOverrideFailed = Effect.fn("ConnectionPromotion.reportOverrideFailed")(function* (
    environmentId: EnvironmentId,
  ) {
    const override = (yield* Ref.get(overrides)).get(environmentId);
    if (override === undefined) {
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(overrides, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* Ref.update(cooldowns, (current) => {
      const next = new Map(current);
      next.set(environmentId, { endpointId: override.endpointId, failedAtEpochMs: now });
      return next;
    });
    yield* Effect.logInfo("Direct environment route failed; falling back to the relay.").pipe(
      Effect.annotateLogs({
        "environment.id": environmentId,
        "promotion.endpoint.id": override.endpointId,
      }),
    );
  });

  const activeCooldownEndpointIds = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    const cooldown = (yield* Ref.get(cooldowns)).get(environmentId);
    if (cooldown === undefined) {
      return new Set<string>();
    }
    const now = yield* Clock.currentTimeMillis;
    if (cooldown.failedAtEpochMs + PROMOTION_FAILURE_COOLDOWN_MS <= now) {
      yield* Ref.update(cooldowns, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      });
      return new Set<string>();
    }
    return new Set([cooldown.endpointId]);
  });

  const probeCandidate = Effect.fnUntraced(function* (
    candidate: AdvertisedEndpoint,
    environmentId: EnvironmentId,
  ) {
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: candidate.httpBaseUrl,
      timeoutMs: CANDIDATE_PROBE_TIMEOUT_MS,
    });
    return descriptor.environmentId === environmentId;
  });

  const discover = Effect.fn("ConnectionPromotion.discover")(function* (
    prepared: PreparedConnection,
  ) {
    const endpoints = yield* fetchAdvertisedEndpoints(prepared, signer).pipe(
      Effect.catch((error) =>
        Effect.logDebug("Advertised endpoint discovery failed.", error).pipe(
          Effect.as<readonly AdvertisedEndpoint[]>([]),
        ),
      ),
    );
    const candidates = selectPromotionCandidates({
      endpoints,
      currentHttpBaseUrl: prepared.httpBaseUrl,
      cooldownEndpointIds: yield* activeCooldownEndpointIds(prepared.environmentId),
    });
    if (candidates.length === 0) {
      return Option.none<PromotedRoute>();
    }
    // Probe candidates concurrently; the same-environment check keeps us from
    // promoting to an unrelated server that happens to answer on a LAN
    // address. Preference order (LAN before tailnet) breaks ties.
    const probed = yield* Effect.all(
      candidates.map((candidate) =>
        probeCandidate(candidate, prepared.environmentId).pipe(Effect.orElseSucceed(() => false)),
      ),
      { concurrency: "unbounded" },
    );
    const chosen = candidates.find((_, index) => probed[index] === true);
    if (chosen === undefined) {
      return Option.none<PromotedRoute>();
    }
    const route: PromotedRoute = {
      endpointId: chosen.id,
      httpBaseUrl: chosen.httpBaseUrl,
      wsBaseUrl: chosen.wsBaseUrl,
    };
    yield* Ref.update(overrides, (current) => {
      const next = new Map(current);
      next.set(prepared.environmentId, route);
      return next;
    });
    yield* Effect.logInfo("Discovered a direct environment route.").pipe(
      Effect.annotateLogs({
        "environment.id": prepared.environmentId,
        "promotion.endpoint.id": route.endpointId,
      }),
    );
    return Option.some(route);
  });

  return ConnectionPromotion.of({
    overrideFor,
    reportOverrideFailed,
    discover: (prepared) =>
      discover(prepared).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
  });
});

export const layer = Layer.effect(ConnectionPromotion, make);
