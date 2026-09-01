import { type AdvertisedEndpoint, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedRelay from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import type { PreparedConnection } from "./model.ts";
import * as ConnectionPromotion from "./promotion.ts";
import { selectPromotionCandidates } from "./promotion.ts";

function endpoint(input: {
  readonly id: string;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpoint["reachability"];
  readonly status?: AdvertisedEndpoint["status"];
}): AdvertisedEndpoint {
  return {
    id: input.id,
    label: input.id,
    provider: { id: "server-core", label: "Server", kind: "core", isAddon: false },
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.httpBaseUrl.replace("http", "ws"),
    reachability: input.reachability,
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "server",
    status: input.status ?? "available",
  };
}

const RELAY_BASE_URL = "https://tunnel.example.test/";

describe("selectPromotionCandidates", () => {
  it("keeps direct lan and private-network endpoints, preferring lan", () => {
    const candidates = selectPromotionCandidates({
      endpoints: [
        endpoint({
          id: "tailscale-ip:http://100.64.0.7:3773",
          httpBaseUrl: "http://100.64.0.7:3773/",
          reachability: "private-network",
        }),
        endpoint({
          id: "server-lan:http://192.168.1.20:3773",
          httpBaseUrl: "http://192.168.1.20:3773/",
          reachability: "lan",
        }),
      ],
      currentHttpBaseUrl: RELAY_BASE_URL,
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "server-lan:http://192.168.1.20:3773",
      "tailscale-ip:http://100.64.0.7:3773",
    ]);
  });

  it("excludes loopback, public, unavailable, and current-route endpoints", () => {
    const candidates = selectPromotionCandidates({
      endpoints: [
        endpoint({
          id: "server-loopback:3773",
          httpBaseUrl: "http://127.0.0.1:3773/",
          reachability: "loopback",
        }),
        endpoint({
          id: "server-public:http://203.0.113.5:3773",
          httpBaseUrl: "http://203.0.113.5:3773/",
          reachability: "public",
        }),
        endpoint({
          id: "tailscale-magicdns:https://machine.tail.ts.net/",
          httpBaseUrl: "https://machine.tail.ts.net/",
          reachability: "private-network",
          status: "unavailable",
        }),
        endpoint({
          id: "server-lan:http://192.168.1.20:3773",
          httpBaseUrl: "http://192.168.1.20:3773",
          reachability: "lan",
        }),
      ],
      // Already connected through the LAN route (normalization makes the
      // trailing-slash difference irrelevant).
      currentHttpBaseUrl: "http://192.168.1.20:3773/",
    });
    expect(candidates).toEqual([]);
  });

  it("excludes endpoints cooling down after a failed promotion", () => {
    const candidates = selectPromotionCandidates({
      endpoints: [
        endpoint({
          id: "server-lan:http://192.168.1.20:3773",
          httpBaseUrl: "http://192.168.1.20:3773/",
          reachability: "lan",
        }),
      ],
      currentHttpBaseUrl: RELAY_BASE_URL,
      cooldownEndpointIds: new Set(["server-lan:http://192.168.1.20:3773"]),
    });
    expect(candidates).toEqual([]);
  });
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const LAN_ENDPOINT = endpoint({
  id: "server-lan:http://192.168.1.20:3773",
  httpBaseUrl: "http://192.168.1.20:3773/",
  reachability: "lan",
});
const TAILNET_ENDPOINT = endpoint({
  id: "tailscale-ip:http://100.100.100.100:3773",
  httpBaseUrl: "http://100.100.100.100:3773/",
  reachability: "private-network",
});
const RELAY_PREPARED: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  httpBaseUrl: RELAY_BASE_URL,
  socketUrl: "wss://tunnel.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "access-token" },
  target: { _tag: "RelayConnectionTarget", environmentId: ENVIRONMENT_ID, label: "Remote" },
};

// Fake fetch: the relay origin answers the advertised endpoint list, and every
// direct candidate answers the descriptor probe as the same environment.
const promotionHarnessLayer = (endpoints: readonly AdvertisedEndpoint[]) => {
  const fetchFn = ((input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/remote-access/endpoints")) {
      return Promise.resolve(Response.json(endpoints));
    }
    if (url.endsWith("/.well-known/t3/environment")) {
      return Promise.resolve(
        Response.json({
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch call to ${url}`));
  }) satisfies typeof fetch;
  return ConnectionPromotion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer(fetchFn),
        Layer.succeed(
          ManagedRelay.ManagedRelayDpopSigner,
          ManagedRelay.ManagedRelayDpopSigner.of({
            thumbprint: Effect.succeed("thumbprint-1"),
            createProof: (proofInput) => Effect.succeed(`proof:${proofInput.url}`),
          }),
        ),
      ),
    ),
  );
};

describe("ConnectionPromotion cooldowns", () => {
  it.effect("keeps every failed endpoint cooling down, not just the latest one", () =>
    Effect.gen(function* () {
      const promotion = yield* ConnectionPromotion.ConnectionPromotion;

      // LAN wins first (ranked above the tailnet), then fails.
      const first = yield* promotion.discover(RELAY_PREPARED);
      expect(Option.map(first, (route) => route.endpointId)).toEqual(Option.some(LAN_ENDPOINT.id));
      yield* promotion.reportOverrideFailed(ENVIRONMENT_ID);

      // The tailnet route is promoted next and fails within the cooldown.
      const second = yield* promotion.discover(RELAY_PREPARED);
      expect(Option.map(second, (route) => route.endpointId)).toEqual(
        Option.some(TAILNET_ENDPOINT.id),
      );
      yield* TestClock.adjust("1 minute");
      yield* promotion.reportOverrideFailed(ENVIRONMENT_ID);

      // Both cooldowns are still active: the LAN route must not be re-selected
      // just because the tailnet failure came later.
      expect(yield* promotion.discover(RELAY_PREPARED)).toEqual(Option.none());

      // The LAN cooldown started first, so it expires first.
      yield* TestClock.adjust("4 minutes");
      const third = yield* promotion.discover(RELAY_PREPARED);
      expect(Option.map(third, (route) => route.endpointId)).toEqual(Option.some(LAN_ENDPOINT.id));
    }).pipe(
      Effect.provide(
        Layer.merge(promotionHarnessLayer([LAN_ENDPOINT, TAILNET_ENDPOINT]), TestClock.layer()),
      ),
    ),
  );
});
