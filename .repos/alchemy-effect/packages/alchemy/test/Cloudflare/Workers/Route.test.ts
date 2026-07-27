import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const main = pathe.resolve(import.meta.dirname, "fixtures", "route-worker.ts");

// Deterministic per-test route patterns. Each test owns a disjoint
// subdomain so reruns and parallel runs never collide, and the same
// pattern is reused on every run (never derive physical names from
// Date.now()/random).
const PATTERN_DEFAULT = `alchemy-route-default.${zoneName}/*`;
const PATTERN_UPDATE_V1 = `alchemy-route-update.${zoneName}/*`;
const PATTERN_UPDATE_V2 = `alchemy-route-update.${zoneName}/api/*`;
const PATTERN_ADOPT = `alchemy-route-adopt.${zoneName}/*`;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently
// 403s with "Unable to authenticate request". Ride out the blips on the
// test's own out-of-band verification calls by retrying the typed
// `Forbidden` error (part of each route operation's error union via
// distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const listByPattern = (zoneId: string, pattern: string) =>
  workers.listRoutes.items({ zoneId }).pipe(
    Stream.filter((r) => r.pattern === pattern),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const findRoute = (zoneId: string, pattern: string) =>
  listByPattern(zoneId, pattern).pipe(Effect.map((rs) => rs[0]));

const getRoute = (zoneId: string, routeId: string) =>
  workers.getRoute({ zoneId, routeId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Delete every route matching the pattern — used to purge leftovers from
// interrupted runs so tests start from a clean slate (Cloudflare enforces
// one route per pattern per zone, so a leaked route would conflict).
const purgeRoutes = (zoneId: string, pattern: string) =>
  listByPattern(zoneId, pattern).pipe(
    Effect.flatMap(
      Effect.forEach((r) =>
        workers
          .deleteRoute({ zoneId, routeId: r.id })
          .pipe(Effect.catch(() => Effect.void)),
      ),
    ),
  );

test.provider(
  "create and delete an opt-out route (no script)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, PATTERN_DEFAULT);

      const route = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.WorkerRoute("DefaultRoute", {
            zoneId,
            pattern: PATTERN_DEFAULT,
          }).pipe(adopt(true));
        }),
      );

      expect(route.routeId).toBeDefined();
      expect(route.zoneId).toEqual(zoneId);
      expect(route.pattern).toEqual(PATTERN_DEFAULT);
      // No script — the route opts matching requests out of Workers.
      expect(route.script).toBeUndefined();

      const live = yield* getRoute(zoneId, route.routeId);
      expect(live.id).toEqual(route.routeId);
      expect(live.pattern).toEqual(PATTERN_DEFAULT);

      yield* stack.destroy();

      const gone = yield* findRoute(zoneId, PATTERN_DEFAULT);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "route to a Worker, then update pattern and script in place",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, PATTERN_UPDATE_V1);
      yield* purgeRoutes(zoneId, PATTERN_UPDATE_V2);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("RouteWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const route = yield* Cloudflare.Workers.WorkerRoute("Route", {
            zoneId,
            pattern: PATTERN_UPDATE_V1,
            script: worker.workerName,
          }).pipe(adopt(true));
          return { worker, route };
        }),
      );

      expect(initial.route.pattern).toEqual(PATTERN_UPDATE_V1);
      expect(initial.route.script).toEqual(initial.worker.workerName);

      const liveInitial = yield* getRoute(zoneId, initial.route.routeId);
      expect(liveInitial.pattern).toEqual(PATTERN_UPDATE_V1);
      expect(liveInitial.script).toEqual(initial.worker.workerName);

      // Pattern and script are both mutable — the same physical route is
      // updated in place (PUT), not replaced.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("RouteWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const route = yield* Cloudflare.Workers.WorkerRoute("Route", {
            zoneId,
            pattern: PATTERN_UPDATE_V2,
            // Drop the script — the route becomes an opt-out route.
          }).pipe(adopt(true));
          return { worker, route };
        }),
      );

      expect(updated.route.routeId).toEqual(initial.route.routeId);
      expect(updated.route.pattern).toEqual(PATTERN_UPDATE_V2);
      expect(updated.route.script).toBeUndefined();

      const liveUpdated = yield* getRoute(zoneId, updated.route.routeId);
      expect(liveUpdated.pattern).toEqual(PATTERN_UPDATE_V2);

      yield* stack.destroy();

      const gone = yield* findRoute(zoneId, PATTERN_UPDATE_V2);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "adoption — existing route errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, PATTERN_ADOPT);

      // Create the route out-of-band so the stack has no state of its own
      // for it — exactly the "the route already exists" scenario.
      const pre = yield* workers
        .createRoute({ zoneId, pattern: PATTERN_ADOPT })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(pre.id).toBeDefined();

      // Without `adopt`: routes carry no ownership markers, so the engine
      // cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Workers.WorkerRoute("AdoptedRoute", {
              zoneId,
              pattern: PATTERN_ADOPT,
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing route
      // (same physical id).
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.WorkerRoute("AdoptedRoute", {
            zoneId,
            pattern: PATTERN_ADOPT,
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.routeId).toEqual(pre.id);
      expect(adopted.pattern).toEqual(PATTERN_ADOPT);

      yield* stack.destroy();

      const gone = yield* findRoute(zoneId, PATTERN_ADOPT);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

const PATTERN_LIST = `alchemy-route-list.${zoneName}/*`;

// Canonical `list()` test (zone-scoped collection): routes have no account-
// wide enumeration API, so `list()` fans out over every zone via
// `listAllZones`, paginates `listRoutes` per zone, and hydrates each into the
// `read` Attributes shape. Deploy a real route and assert it appears in the
// exhaustively-enumerated result.
test.provider(
  "list enumerates the deployed route across all zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, PATTERN_LIST);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("ListRouteWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const route = yield* Cloudflare.Workers.WorkerRoute("ListRoute", {
            zoneId,
            pattern: PATTERN_LIST,
            script: worker.workerName,
          }).pipe(adopt(true));
          return { worker, route };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Workers.WorkerRoute,
      );
      const all = yield* provider.list();

      expect(
        all.some(
          (r) =>
            r.routeId === deployed.route.routeId &&
            r.zoneId === zoneId &&
            r.pattern === PATTERN_LIST,
        ),
      ).toBe(true);

      yield* stack.destroy();

      const gone = yield* findRoute(zoneId, PATTERN_LIST);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );
