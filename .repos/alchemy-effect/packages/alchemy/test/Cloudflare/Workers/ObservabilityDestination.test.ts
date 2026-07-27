import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "observability-sink-worker.ts",
);

// Deterministic per-test destination names. Cloudflare enforces one
// destination per name account-wide, so each test owns disjoint names and
// reuses them on every run (never derive physical names from
// Date.now()/random).
const NAME_DEFAULT_URL = "https://example.com";
const NAME_UPDATE = "alchemy-obsdest-update";
const NAME_REPLACE_V1 = "alchemy-obsdest-replace-v1";
const NAME_REPLACE_V2 = "alchemy-obsdest-replace-v2";
const NAME_LIST = "alchemy-obsdest-list";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on the test's own out-of-band
// verification calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const listDestinations = (accountId: string) =>
  workers.listObservabilityDestinations.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const findByName = (accountId: string, name: string) =>
  listDestinations(accountId).pipe(
    Effect.map((ds) => ds.find((d) => d.name === name)),
  );

// Delete every destination with the given name — used to purge leftovers
// from interrupted runs so tests start from a clean slate (Cloudflare
// enforces name uniqueness, so a leaked destination would conflict).
const purgeByName = (accountId: string, name: string) =>
  listDestinations(accountId).pipe(
    Effect.flatMap(
      Effect.forEach((d) =>
        d.name === name
          ? workers
              .deleteObservabilityDestination({ accountId, slug: d.slug })
              .pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
    ),
  );

const expectGone = (accountId: string, name: string) =>
  findByName(accountId, name).pipe(
    Effect.flatMap((found) =>
      found
        ? Effect.fail({ _tag: "DestinationNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "DestinationNotDeleted",
      schedule: Schedule.exponential("500 millis"),
      times: 10,
    }),
  );

test.provider(
  "create and delete a destination with default name",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const dest = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.ObservabilityDestination(
            "DefaultDest",
            {
              url: NAME_DEFAULT_URL,
              logpushDataset: "opentelemetry-logs",
              // example.com rejects POSTs, so skip the create-time probe —
              // this test never updates, and updates are what re-preflight.
              skipPreflightCheck: true,
            },
          ).pipe(adopt(true));
        }),
      );

      expect(dest.slug).toBeDefined();
      expect(dest.accountId).toEqual(accountId);
      expect(dest.url).toEqual(NAME_DEFAULT_URL);
      expect(dest.logpushDataset).toEqual("opentelemetry-logs");
      expect(dest.enabled).toBe(true);
      expect(dest.scripts).toEqual([]);

      const live = yield* findByName(accountId, dest.name);
      expect(live?.slug).toEqual(dest.slug);
      expect(live?.configuration.url).toEqual(NAME_DEFAULT_URL);
      expect(live?.configuration.logpushDataset).toEqual("opentelemetry-logs");

      yield* stack.destroy();

      yield* expectGone(accountId, dest.name);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "update url, headers, and enabled in place (same slug)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* purgeByName(accountId, NAME_UPDATE);

      // The destination's endpoint is a deployed Worker that answers 200
      // to everything — Cloudflare re-runs the endpoint preflight (a POST)
      // on every in-place update, so the sink must be live.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("ObsSinkWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const dest = yield* Cloudflare.Workers.ObservabilityDestination(
            "Dest",
            {
              name: NAME_UPDATE,
              url: worker.url.as<string>(),
              logpushDataset: "opentelemetry-traces",
              // Fresh workers.dev URLs take a few seconds to start serving —
              // skip the create-time probe; the update below exercises the
              // real preflight.
              skipPreflightCheck: true,
            },
          ).pipe(adopt(true));
          return { worker, dest };
        }),
      );

      expect(initial.dest.name).toEqual(NAME_UPDATE);
      expect(initial.dest.url).toEqual(initial.worker.url);
      expect(initial.dest.enabled).toBe(true);

      // Warm the sink through edge propagation so the update's preflight
      // POST lands on a serving workers.dev URL. Fresh workers.dev hosts
      // answer 404 until the subdomain propagates, so poll until 200.
      const client = yield* HttpClient.HttpClient;
      const warm = yield* client.get(initial.worker.url!).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res) => res.status === 200,
          times: 60,
        }),
      );
      expect(warm.status).toBe(200);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("ObsSinkWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const dest = yield* Cloudflare.Workers.ObservabilityDestination(
            "Dest",
            {
              name: NAME_UPDATE,
              url: worker.url.as<string>(),
              headers: { "x-alchemy-test": "1" },
              logpushDataset: "opentelemetry-traces",
              enabled: false,
            },
          ).pipe(adopt(true));
          return { worker, dest };
        }),
      );

      // Same destination mutated in place — not a replacement.
      expect(updated.dest.slug).toEqual(initial.dest.slug);
      expect(updated.dest.url).toEqual(updated.worker.url);
      expect(updated.dest.enabled).toBe(false);

      const live = yield* findByName(accountId, NAME_UPDATE);
      expect(live?.slug).toEqual(initial.dest.slug);
      expect(live?.enabled).toBe(false);
      expect(live?.configuration.url).toEqual(updated.worker.url);
      expect(live?.configuration.headers["x-alchemy-test"]).toEqual("1");

      // Redeploying identical props is a no-op (and must not re-preflight).
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("ObsSinkWorker", {
            main,
            compatibility: { date: "2024-01-01" },
          });
          const dest = yield* Cloudflare.Workers.ObservabilityDestination(
            "Dest",
            {
              name: NAME_UPDATE,
              url: worker.url.as<string>(),
              headers: { "x-alchemy-test": "1" },
              logpushDataset: "opentelemetry-traces",
              enabled: false,
            },
          ).pipe(adopt(true));
          return { worker, dest };
        }),
      );
      expect(noop.dest.slug).toEqual(initial.dest.slug);

      yield* stack.destroy();

      yield* expectGone(accountId, NAME_UPDATE);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "replacement on name change (new slug, old destination removed)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* purgeByName(accountId, NAME_REPLACE_V1);
      yield* purgeByName(accountId, NAME_REPLACE_V2);

      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.ObservabilityDestination(
            "ReplaceDest",
            {
              name: NAME_REPLACE_V1,
              url: NAME_DEFAULT_URL,
              logpushDataset: "opentelemetry-logs",
              skipPreflightCheck: true,
            },
          ).pipe(adopt(true));
        }),
      );
      expect(v1.name).toEqual(NAME_REPLACE_V1);

      // The slug is derived from the name and the update API cannot
      // rename — a name change replaces the physical destination.
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.ObservabilityDestination(
            "ReplaceDest",
            {
              name: NAME_REPLACE_V2,
              url: NAME_DEFAULT_URL,
              logpushDataset: "opentelemetry-logs",
              skipPreflightCheck: true,
            },
          ).pipe(adopt(true));
        }),
      );

      expect(v2.name).toEqual(NAME_REPLACE_V2);
      expect(v2.slug).not.toEqual(v1.slug);

      const liveV2 = yield* findByName(accountId, NAME_REPLACE_V2);
      expect(liveV2?.slug).toEqual(v2.slug);
      // The replaced destination is cleaned up.
      yield* expectGone(accountId, NAME_REPLACE_V1);

      yield* stack.destroy();

      yield* expectGone(accountId, NAME_REPLACE_V2);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

test.provider(
  "list enumerates the deployed destination",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* purgeByName(accountId, NAME_LIST);

      const dest = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Workers.ObservabilityDestination(
            "ListDest",
            {
              name: NAME_LIST,
              url: NAME_DEFAULT_URL,
              logpushDataset: "opentelemetry-logs",
              // example.com rejects POSTs, so skip the create-time probe.
              skipPreflightCheck: true,
            },
          ).pipe(adopt(true));
        }),
      );

      // Typed provider lookup — `findProvider` infers the element type as the
      // resource's Attributes, so `list()` is fully typed (no `any`).
      const provider = yield* Provider.findProvider(
        Cloudflare.Workers.ObservabilityDestination,
      );
      const all = yield* provider.list();

      // The exhaustively-paginated result contains our deployed destination,
      // hydrated into the exact `read` Attributes shape.
      const found = all.find((d) => d.slug === dest.slug);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.name).toEqual(NAME_LIST);
      expect(found?.url).toEqual(NAME_DEFAULT_URL);
      expect(found?.logpushDataset).toEqual("opentelemetry-logs");

      yield* stack.destroy();

      yield* expectGone(accountId, NAME_LIST);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
