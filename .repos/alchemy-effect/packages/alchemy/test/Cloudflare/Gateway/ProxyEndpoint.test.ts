import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge.
const getEndpoint = (accountId: string, proxyEndpointId: string) =>
  zeroTrust.getGatewayProxyEndpoint({ accountId, proxyEndpointId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted endpoint surfaces as `ProxyEndpointNotFound` (code 2002).
const expectGone = (accountId: string, proxyEndpointId: string) =>
  getEndpoint(accountId, proxyEndpointId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "EndpointNotDeleted" } as const)),
    Effect.catchTag("ProxyEndpointNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "EndpointNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update, and destroy an identity-kind proxy endpoint",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const endpoint = yield* stack.deploy(
        Cloudflare.Gateway.ProxyEndpoint("IdentityProxy", {
          name: "alchemy-zt-proxy-identity",
          kind: "identity",
        }),
      );

      expect(endpoint.proxyEndpointId).toBeTruthy();
      expect(endpoint.accountId).toEqual(accountId);
      expect(endpoint.kind).toEqual("identity");
      // Cloudflare assigns a stable PAC/proxy subdomain.
      expect(endpoint.subdomain).toBeTruthy();

      const live = yield* getEndpoint(accountId, endpoint.proxyEndpointId);
      expect(live.name).toEqual("alchemy-zt-proxy-identity");
      expect(live.subdomain).toEqual(endpoint.subdomain);

      // Rename in place — same id, same subdomain.
      const updated = yield* stack.deploy(
        Cloudflare.Gateway.ProxyEndpoint("IdentityProxy", {
          name: "alchemy-zt-proxy-identity-v2",
          kind: "identity",
        }),
      );
      expect(updated.proxyEndpointId).toEqual(endpoint.proxyEndpointId);
      expect(updated.subdomain).toEqual(endpoint.subdomain);
      expect(updated.name).toEqual("alchemy-zt-proxy-identity-v2");

      const liveAfter = yield* getEndpoint(accountId, endpoint.proxyEndpointId);
      expect(liveAfter.name).toEqual("alchemy-zt-proxy-identity-v2");

      yield* stack.destroy();
      yield* expectGone(accountId, endpoint.proxyEndpointId);
    }).pipe(logLevel),
);

// IP-based proxy endpoints are an Enterprise entitlement. On the testing
// account, creation fails with the typed `IpProxyEndpointsRequireEnterprise`
// error (Cloudflare code 2009: "IP based proxy endpoints are limited to
// enterprise accounts."). Exercise the typed error surface directly; if the
// account ever becomes Enterprise the create succeeds and we clean up.
test.provider("ip-kind endpoints surface the typed entitlement error", () =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    const outcome = yield* zeroTrust
      .createGatewayProxyEndpoint({
        accountId,
        name: "alchemy-zt-proxy-ip",
        kind: "ip",
        // RFC 5737 documentation range.
        ips: ["203.0.113.1/32"],
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
        Effect.map((created) => ({ _tag: "Created" as const, created })),
        Effect.catchTag("IpProxyEndpointsRequireEnterprise", (e) =>
          Effect.succeed({ _tag: "Entitlement" as const, error: e }),
        ),
      );

    if (outcome._tag === "Created") {
      // Enterprise account — clean up the endpoint we just made.
      yield* zeroTrust
        .deleteGatewayProxyEndpoint({
          accountId,
          proxyEndpointId: outcome.created.id ?? "",
        })
        .pipe(Effect.catchTag("ProxyEndpointNotFound", () => Effect.void));
      expect(outcome.created.name).toEqual("alchemy-zt-proxy-ip");
    } else {
      expect(outcome.error._tag).toEqual("IpProxyEndpointsRequireEnterprise");
    }
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed proxy endpoint", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Self-heal: remove any same-named endpoint left orphaned in the cloud by a
    // previously-interrupted run so the deploy below doesn't trip the
    // "OwnedBySomeoneElse" adoption guard.
    const orphans = yield* zeroTrust.listGatewayProxyEndpoints
      .items({ accountId })
      .pipe(
        Stream.filter((e) => e.name === "alchemy-zt-proxy-list"),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
    yield* Effect.forEach(orphans, (o) =>
      zeroTrust
        .deleteGatewayProxyEndpoint({ accountId, proxyEndpointId: o.id ?? "" })
        .pipe(Effect.catchTag("ProxyEndpointNotFound", () => Effect.void)),
    );

    // identity-kind endpoints work on all Zero Trust plans, so this deploy is
    // not entitlement-gated (unlike ip-kind, which needs Enterprise).
    const endpoint = yield* stack.deploy(
      Cloudflare.Gateway.ProxyEndpoint("ListProxy", {
        name: "alchemy-zt-proxy-list",
        kind: "identity",
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Gateway.ProxyEndpoint,
    );
    const all = yield* provider.list();

    const match = all.find(
      (x) => x.proxyEndpointId === endpoint.proxyEndpointId,
    );
    expect(match).toBeDefined();
    expect(match?.accountId).toEqual(accountId);
    expect(match?.name).toEqual("alchemy-zt-proxy-list");
    expect(match?.kind).toEqual("identity");

    yield* stack.destroy();
  }).pipe(logLevel),
);
