import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic hostnames on the testing zone — hostnames are unique per
// account, so reruns converge on the same route instead of leaking. The two
// cases run CONCURRENTLY, so each owns a DISTINCT hostname (and tunnel):
// sharing one hostname makes the two deploys race to route it to their own
// tunnel and the loser fails with `HostnameRouteAlreadyRouted`.
const HOSTNAME = "alchemy-test-hr.alchemy-test-2.us";
const LIST_HOSTNAME = "alchemy-test-hr-list.alchemy-test-2.us";

// Read a hostname route out-of-band, mapping "gone" (404 or a tombstoned
// deletedAt) to undefined.
const getLiveRoute = (accountId: string, hostnameRouteId: string) =>
  zeroTrust.getNetworkHostnameRoute({ accountId, hostnameRouteId }).pipe(
    Effect.map((r) => (r.deletedAt != null ? undefined : r)),
    Effect.catchTag("HostnameRouteNotFound", () => Effect.succeed(undefined)),
  );

// Delete every live route currently routing `hostname`, regardless of which
// tunnel it points to. A per-stack `destroy()` only removes the route tracked
// under this stack's logical id, so a leftover from a previously crashed run
// (possibly pointing at a now-deleted tunnel) keeps the hostname reserved and
// the next create fails with `HostnameRouteAlreadyRouted`. Sweeping by hostname
// makes the suite self-healing and leaves no dangling routes behind.
const cleanupRoutesByHostname = (accountId: string, hostname: string) =>
  zeroTrust.listNetworkHostnameRoutes({ accountId }).pipe(
    Effect.map((list) =>
      (list.result ?? []).filter(
        (r) => r.hostname === hostname && r.id != null && r.deletedAt == null,
      ),
    ),
    Effect.flatMap((routes) =>
      Effect.forEach(routes, (r) =>
        zeroTrust
          .deleteNetworkHostnameRoute({ accountId, hostnameRouteId: r.id! })
          .pipe(Effect.catchTag("HostnameRouteNotFound", () => Effect.void)),
      ),
    ),
    Effect.catchTag("Forbidden", () => Effect.void),
  );

test.provider(
  "create, update comment in place, and destroy a hostname route",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* cleanupRoutesByHostname(accountId, HOSTNAME);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel.Tunnel("HrTunnel", {
            adopt: true,
          });
          const route = yield* Cloudflare.Tunnel.HostnameRoute("AppRoute", {
            hostname: HOSTNAME,
            tunnelId: tunnel.tunnelId,
            comment: "v1",
          });
          return { tunnel, route };
        }),
      );

      expect(initial.route.hostnameRouteId).toBeDefined();
      expect(initial.route.accountId).toEqual(accountId);
      expect(initial.route.hostname).toEqual(HOSTNAME);
      expect(initial.route.tunnelId).toEqual(initial.tunnel.tunnelId);
      expect(initial.route.comment).toEqual("v1");

      const live = yield* getLiveRoute(
        accountId,
        initial.route.hostnameRouteId,
      );
      expect(live?.hostname).toEqual(HOSTNAME);
      expect(live?.comment).toEqual("v1");

      // Comment update converges in place — same route id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel.Tunnel("HrTunnel", {
            adopt: true,
          });
          const route = yield* Cloudflare.Tunnel.HostnameRoute("AppRoute", {
            hostname: HOSTNAME,
            tunnelId: tunnel.tunnelId,
            comment: "v2",
          });
          return { route };
        }),
      );
      expect(updated.route.hostnameRouteId).toEqual(
        initial.route.hostnameRouteId,
      );
      expect(updated.route.comment).toEqual("v2");

      const liveUpdated = yield* getLiveRoute(
        accountId,
        initial.route.hostnameRouteId,
      );
      expect(liveUpdated?.comment).toEqual("v2");

      yield* stack.destroy();

      // Cloudflare tombstones hostname routes; gone = 404 or deletedAt set.
      const afterDestroy = yield* getLiveRoute(
        accountId,
        initial.route.hostnameRouteId,
      );
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "list enumerates the deployed hostname route",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* cleanupRoutesByHostname(accountId, LIST_HOSTNAME);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const tunnel = yield* Cloudflare.Tunnel.Tunnel("HrListTunnel", {
            adopt: true,
          });
          const route = yield* Cloudflare.Tunnel.HostnameRoute("ListRoute", {
            hostname: LIST_HOSTNAME,
            tunnelId: tunnel.tunnelId,
            comment: "list",
          });
          return { route };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Tunnel.HostnameRoute,
      );

      // The account-wide list is eventually consistent right after a create —
      // poll until the freshly-deployed route is enumerated.
      const all = yield* provider.list().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (routes) =>
            routes.some(
              (r) => r.hostnameRouteId === deployed.route.hostnameRouteId,
            ),
          times: 10,
        }),
      );

      expect(
        all.some((r) => r.hostnameRouteId === deployed.route.hostnameRouteId),
      ).toBe(true);

      yield* stack.destroy();

      const afterDestroy = yield* getLiveRoute(
        accountId,
        deployed.route.hostnameRouteId,
      );
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
