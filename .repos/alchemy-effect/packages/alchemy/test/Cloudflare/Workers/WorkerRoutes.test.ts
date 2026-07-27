import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { expectUrlAbsent, expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

const zoneName =
  process.env.CLOUDFLARE_TEST_WORKER_ROUTE_ZONE_NAME ??
  process.env.CLOUDFLARE_TEST_R2_DOMAIN_ZONE_NAME ??
  "alchemy-test-2.us";

// Deterministic per-test path prefixes on the zone apex. Each test owns a
// disjoint prefix so reruns and parallel runs never collide, and the same
// patterns are reused on every run (never derive names from Date.now()).
const routeSuffix = `alchemy-worker-route-${process.env.PULL_REQUEST ?? process.env.USER}`;

const workerMarker = "Hello from TestWorker";

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

// A freshly-minted scoped API token propagates eventually-consistently
// across Cloudflare's edge — retry the typed `Forbidden` blips on the
// tests' own out-of-band verification calls.
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

// Workers only run on proxied hostnames, so the zone apex needs a proxied
// placeholder record for route-matched requests to reach Cloudflare's edge
// at all. The record is standing test-zone infrastructure (like the zone
// itself): ensure it exists out-of-band, never tear it down.
const ensureApexPlaceholder = (zoneId: string) =>
  Effect.gen(function* () {
    const existing = yield* dns.listRecords.items({ zoneId }).pipe(
      Stream.filter(
        (r) => r.name === zoneName && (r.type === "A" || r.type === "AAAA"),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );
    if (existing) return;
    yield* dns.createRecord({
      zoneId,
      name: zoneName,
      type: "AAAA",
      content: "100::",
      proxied: true,
      ttl: 1,
      comment: "standing placeholder so Workers routes serve on the zone apex",
    });
  });

// Delete every route matching the pattern — purge leftovers from
// interrupted runs so tests start from a clean slate (Cloudflare enforces
// one route per pattern per zone).
const purgeRoutes = (zoneId: string, ...patterns: string[]) =>
  Effect.forEach(patterns, (pattern) =>
    listByPattern(zoneId, pattern).pipe(
      Effect.flatMap(
        Effect.forEach((r) =>
          workers
            .deleteRoute({ zoneId, routeId: r.id })
            .pipe(Effect.catch(() => Effect.void)),
        ),
      ),
    ),
  );

// --- lifecycle: create → no-op → update (change + add) → remove ---------

const T1_V1 = `${zoneName}/${routeSuffix}/t1/api/*`;
const T1_V2 = `${zoneName}/${routeSuffix}/t1/api/v2/*`;
const T1_ADDED = `${zoneName}/${routeSuffix}/t1/other/*`;
const T1_MATCH_URL = `https://${zoneName}/${routeSuffix}/t1/api/ping`;
const T1_MISS_URL = `https://${zoneName}/${routeSuffix}/t1/unknown`;

test.provider.skipIf(!zoneName)(
  "creates, keeps, updates, and removes worker zone routes",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, T1_V1, T1_V2, T1_ADDED);
      yield* ensureApexPlaceholder(zoneId);

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        // Create — zone resolved from `zoneName`.
        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RouteWorker", {
              main,
              url: false,
              routes: [{ pattern: T1_V1, zoneName }],
            });
          }),
        );
        workerName = worker.workerName;

        expect(worker.routes).toHaveLength(1);
        expect(worker.routes[0]?.pattern).toEqual(T1_V1);
        expect(worker.routes[0]?.zoneId).toEqual(zoneId);
        const initialRouteId = worker.routes[0]!.id;

        const liveRoute = yield* findRoute(zoneId, T1_V1);
        expect(liveRoute?.script).toEqual(worker.workerName);

        yield* expectUrlContains(T1_MATCH_URL, workerMarker, {
          label: "worker route match",
          timeout: "60 seconds",
        });
        yield* expectUrlAbsent(T1_MISS_URL, workerMarker, {
          label: "worker route miss",
          timeout: "30 seconds",
        });

        // No-op — identical props must not churn the route (same id).
        const noop = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RouteWorker", {
              main,
              url: false,
              routes: [{ pattern: T1_V1, zoneName }],
            });
          }),
        );
        expect(noop.routes).toHaveLength(1);
        expect(noop.routes[0]?.id).toEqual(initialRouteId);

        // Update — change the first pattern (delete + create, addressed by
        // explicit `zoneId`) and add a second route whose zone is inferred
        // from the pattern's hostname.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RouteWorker", {
              main,
              url: false,
              routes: [{ pattern: T1_V2, zoneId }, { pattern: T1_ADDED }],
            });
          }),
        );

        const updatedPatterns = updated.routes.map((r) => r.pattern).sort();
        expect(updatedPatterns).toEqual([T1_V2, T1_ADDED].sort());
        expect(updated.routes.every((r) => r.zoneId === zoneId)).toBe(true);

        expect(yield* findRoute(zoneId, T1_V1)).toBeUndefined();
        expect((yield* findRoute(zoneId, T1_V2))?.script).toEqual(
          worker.workerName,
        );
        expect((yield* findRoute(zoneId, T1_ADDED))?.script).toEqual(
          worker.workerName,
        );

        // Remove — omitting the `routes` prop entirely detaches everything
        // recorded in the previous state.
        const removed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RouteWorker", {
              main,
              url: false,
            });
          }),
        );
        expect(removed.routes).toHaveLength(0);

        expect(yield* findRoute(zoneId, T1_V2)).toBeUndefined();
        expect(yield* findRoute(zoneId, T1_ADDED)).toBeUndefined();
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(
                Effect.ignore,
              );
            }
          }),
        ),
      );
    }).pipe(logLevel),
  { timeout: 300_000 },
);

// --- observed state is the baseline: drift removal + destroy cleanup ----

const T2_KEPT = `${zoneName}/${routeSuffix}/t2/api/*`;
const T2_DRIFT = `${zoneName}/${routeSuffix}/t2/drift/*`;

test.provider.skipIf(!zoneName)(
  "removes out-of-band routes on update and detaches routes on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, T2_KEPT, T2_DRIFT);

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DriftRouteWorker", {
              main,
              url: false,
              compatibility: { date: "2024-01-01" },
              routes: [{ pattern: T2_KEPT, zoneName }],
            });
          }),
        );
        workerName = worker.workerName;
        const keptRouteId = worker.routes[0]!.id;

        // Attach a route to the same script out-of-band — the reconciler
        // never recorded it, so it is pure drift.
        const drift = yield* workers
          .createRoute({
            zoneId,
            pattern: T2_DRIFT,
            script: worker.workerName,
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: forbiddenRetrySchedule,
              times: 8,
            }),
          );
        expect(drift.id).toBeDefined();

        // Force an update (compat date bump) with the same desired routes:
        // the kept route must survive untouched (same id) and the drift
        // route — observed in the same zone, attached to this script, not
        // desired — must be removed.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("DriftRouteWorker", {
              main,
              url: false,
              compatibility: { date: "2024-01-02" },
              routes: [{ pattern: T2_KEPT, zoneName }],
            });
          }),
        );

        expect(updated.routes).toHaveLength(1);
        expect(updated.routes[0]?.id).toEqual(keptRouteId);
        expect(yield* findRoute(zoneId, T2_DRIFT)).toBeUndefined();
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(
                Effect.ignore,
              );
            }
          }),
        ),
      );

      // Destroying the worker detaches its routes from the zone.
      expect(yield* findRoute(zoneId, T2_KEPT)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

// --- refusal: a pattern already routed to a different Worker ------------

const T3_PATTERN = `${zoneName}/${routeSuffix}/t3/api/*`;

test.provider.skipIf(!zoneName)(
  "refuses to steal a route pattern attached to another Worker",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRoutes(zoneId, T3_PATTERN);

      yield* Effect.gen(function* () {
        const owner = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("RouteOwnerWorker", {
              main,
              url: false,
              routes: [{ pattern: T3_PATTERN, zoneName }],
            });
          }),
        );

        const error = yield* stack
          .deploy(
            Effect.gen(function* () {
              const owner = yield* Cloudflare.Worker("RouteOwnerWorker", {
                main,
                url: false,
                routes: [{ pattern: T3_PATTERN, zoneName }],
              });
              const thief = yield* Cloudflare.Worker("RouteThiefWorker", {
                main,
                url: false,
                routes: [{ pattern: T3_PATTERN, zoneName }],
              });
              return { owner, thief };
            }),
          )
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) =>
              Effect.succeed(findAttachRefusal(cause)),
            ),
          );

        expect(error).toBeDefined();
        expect(error?.message).toContain("already attached to Worker");

        // The pattern still routes to its original owner.
        const live = yield* findRoute(zoneId, T3_PATTERN);
        expect(live?.script).toEqual(owner.workerName);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  { timeout: 300_000 },
);

/**
 * Pull the attach-refusal `Error` out of a Cause regardless of whether the
 * engine surfaced it as a typed failure or a defect (`Effect.die`).
 */
const findAttachRefusal = (cause: Cause.Cause<unknown>): Error | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is Error =>
        value instanceof Error &&
        value.message.includes("already attached to Worker"),
    );
