import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Magic Transit is an entitlement-gated product — see GreTunnel.test.ts.
// The probe test always runs and pins the typed gate tag; the lifecycle
// test is opt-in for entitled accounts.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

const cfEndpoint = process.env.CLOUDFLARE_TEST_MT_CF_ENDPOINT ?? "203.0.113.1";

const getRoute = (accountId: string, routeId: string) =>
  magicTransit.getRoute({ accountId, routeId });

// Poll until the route is gone after destroy. Cloudflare answers GET for
// a missing route with the typed `RouteNotFound` (code 1020).
const expectGone = (accountId: string, routeId: string) =>
  getRoute(accountId, routeId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "RouteNotDeleted" } as const)),
    Effect.catchTag("RouteNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RouteNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "unentitled accounts surface the typed MagicTransitNotOnboarded error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* magicTransit.listRoutes({ accountId }).pipe(
        Effect.as(true),
        Effect.catchTag(["MagicTransitNotOnboarded", "Forbidden"], () =>
          Effect.succeed(false),
        ),
      );
      if (canList) {
        yield* Effect.logInfo(
          "account is Magic Transit-entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* magicTransit
        .listRoutes({ accountId })
        .pipe(Effect.flip);
      expect(["MagicTransitNotOnboarded", "Forbidden"]).toContain(error._tag);

      const createError = yield* magicTransit
        .createRoute({
          accountId,
          prefix: "10.100.0.0/24",
          nexthop: "10.213.10.11",
          priority: 100,
        })
        .pipe(Effect.flip);
      expect(["MagicTransitNotOnboarded", "Forbidden"]).toContain(
        createError._tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only: list() must resolve via the typed provider and return a
// well-typed array even on unentitled accounts (the account-scoped
// `MagicTransitNotOnboarded` gate is mapped to `[]`).
test.provider("list returns a well-typed array of routes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.MagicTransit.MagicStaticRoute,
    );
    const all = yield* provider.list();
    expect(Array.isArray(all)).toBe(true);
    for (const route of all) {
      expect(typeof route.routeId).toBe("string");
      expect(typeof route.accountId).toBe("string");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "list enumerates the deployed static route",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      yield* stack.deploy(
        Cloudflare.MagicTransit.GreTunnel("ListRouteGre", {
          name: "alch-gre-listroute1",
          cloudflareGreEndpoint: cfEndpoint,
          customerGreEndpoint: "198.51.100.31",
          interfaceAddress: "10.213.14.10/31",
        }),
      );

      const route = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicStaticRoute("ListRoute", {
          prefix: "10.114.0.0/24",
          nexthop: "10.213.14.11",
          priority: 100,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicStaticRoute,
      );
      const all = yield* provider.list();

      const found = all.find((r) => r.routeId === route.routeId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.prefix).toEqual("10.114.0.0/24");
      expect(found?.nexthop).toEqual("10.213.14.11");

      yield* stack.destroy();

      yield* expectGone(accountId, route.routeId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "routes a prefix over a GRE tunnel, updates in place, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // A static route's nexthop must live on a Magic tunnel interface.
      const tunnel = yield* stack.deploy(
        Cloudflare.MagicTransit.GreTunnel("RouteGre", {
          name: "alch-gre-route1",
          cloudflareGreEndpoint: cfEndpoint,
          customerGreEndpoint: "198.51.100.30",
          interfaceAddress: "10.213.12.10/31",
        }),
      );

      const route = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicStaticRoute("Route", {
          prefix: "10.112.0.0/24",
          nexthop: "10.213.12.11",
          priority: 100,
          description: "alchemy static route test",
        }),
      );

      expect(route.routeId).toBeTruthy();
      expect(route.accountId).toEqual(accountId);
      expect(route.prefix).toEqual("10.112.0.0/24");
      expect(route.nexthop).toEqual("10.213.12.11");
      expect(route.priority).toEqual(100);

      // Out-of-band verification via the distilled API.
      const live = yield* getRoute(accountId, route.routeId);
      expect(live.route?.prefix).toEqual("10.112.0.0/24");
      expect(live.route?.description).toEqual("alchemy static route test");

      // Update mutable props in place — same routeId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicStaticRoute("Route", {
          prefix: "10.112.0.0/24",
          nexthop: "10.213.12.11",
          priority: 150,
          description: "alchemy static route test v2",
        }),
      );

      expect(updated.routeId).toEqual(route.routeId);
      expect(updated.priority).toEqual(150);
      expect(updated.description).toEqual("alchemy static route test v2");

      yield* stack.destroy();

      yield* expectGone(accountId, route.routeId);
      // The tunnel is destroyed alongside the route.
      const tunnelGone = yield* magicTransit
        .getGreTunnel({
          accountId,
          greTunnelId: tunnel.tunnelId,
          xMagicNewHcTarget: true,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("GreTunnelNotFound", () => Effect.succeed(true)),
        );
      expect(tunnelGone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
