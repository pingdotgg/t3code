import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RedisApi, {
  Cache,
  REDIS_VALUE,
  RedisIp,
  RedisSite,
} from "./fixtures/redis-api.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilRedisGone = (redisId: string, name: string) =>
  Fly.findRedisAddOn({ id: redisId, name }).pipe(
    Effect.map((row) =>
      row === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "lists cheapest redis plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const plans = yield* Fly.listRedisPlans();
      expect(plans.length).toBeGreaterThan(0);
      const cheapest = plans
        .slice()
        .sort(
          (left, right) =>
            (left.pricePerMonth ?? 0) - (right.pricePerMonth ?? 0),
        )[0];
      expect(cheapest?.id).toEqual(expect.any(String));
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "create, update eviction, and delete redis",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Redis("Cache");
        }),
      );

      expect(created.redisId).toEqual(expect.any(String));
      expect(created.redisId.length).toBeGreaterThan(0);
      expect(created.name).toEqual(expect.any(String));
      expect(created.name.length).toBeGreaterThan(0);
      expect(created.primaryRegion).toEqual("iad");
      expect(created.planName).toEqual(expect.any(String));

      const fetched = yield* Fly.findRedisAddOn({
        id: created.redisId,
        name: created.name,
      });
      expect(fetched?.id).toEqual(created.redisId);
      expect(fetched?.name).toEqual(created.name);
      expect(fetched?.primaryRegion).toEqual("iad");

      const provider = yield* Provider.findProvider(Fly.Redis);
      const listed = yield* provider.list();
      const found = listed.find((row) => row.redisId === created.redisId);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Redis("Cache", {
            eviction: true,
          });
        }),
      );

      expect(updated.redisId).toEqual(created.redisId);
      expect(updated.name).toEqual(created.name);
      expect(updated.eviction).toEqual(true);

      const refetched = yield* Fly.findRedisAddOn({
        id: updated.redisId,
        name: updated.name,
      });
      expect(refetched?.id).toEqual(updated.redisId);
      const options = refetched?.options as { eviction?: boolean } | null;
      expect(options?.eviction).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilRedisGone(created.redisId, created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Redis("ReplaceName");
        }),
      );

      const nextName =
        created.name.slice(0, -1) + (created.name.endsWith("z") ? "y" : "z");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Redis("ReplaceName", {
            name: nextName,
          });
        }),
      );

      expect(replaced.name).toEqual(nextName);
      expect(replaced.redisId).not.toEqual(created.redisId);

      const oldGone = yield* waitUntilRedisGone(created.redisId, created.name);
      expect(oldGone).toEqual("gone");

      const fetched = yield* Fly.findRedisAddOn({
        id: replaced.redisId,
        name: replaced.name,
      });
      expect(fetched?.name).toEqual(nextName);

      yield* stack.destroy();

      const gone = yield* waitUntilRedisGone(replaced.redisId, replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when primaryRegion changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Redis("ReplaceRegion", {
            primaryRegion: "iad",
          });
        }),
      );

      expect(created.primaryRegion).toEqual("iad");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Redis("ReplaceRegion", {
            primaryRegion: "ewr",
          });
        }),
      );

      expect(replaced.primaryRegion).toEqual("ewr");
      expect(replaced.redisId).not.toEqual(created.redisId);

      const fetched = yield* Fly.findRedisAddOn({
        id: replaced.redisId,
        name: replaced.name,
      });
      expect(fetched?.primaryRegion).toEqual("ewr");

      yield* stack.destroy();

      const gone = yield* waitUntilRedisGone(replaced.redisId, replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "a Service pings Redis and round-trips a key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* RedisSite;
          const cache = yield* Cache;
          const ip = yield* RedisIp;
          const api = yield* RedisApi;
          return { app, cache, ip, api };
        }),
      );

      expect(deployed.cache.redisId).toEqual(expect.any(String));
      expect(deployed.api.url).toEqual(
        `https://${deployed.app.appName}.fly.dev`,
      );

      const secrets = yield* machines.listSecrets({
        app_name: deployed.app.appName,
        show_secrets: false,
      });
      const redisUrl = (secrets.secrets ?? []).find(
        (secret) => secret.name === Fly.REDIS_URL_ENV,
      );
      expect(redisUrl).toBeDefined();
      expect(redisUrl?.digest).toEqual(expect.any(String));

      const untilOk = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.retry({
            schedule: Schedule.spaced("4 seconds"),
            times: 10,
          }),
        );

      const ping = yield* untilOk(
        HttpClient.get(`${deployed.api.url}/`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`api returned ${res.status}`)),
          ),
          Effect.map((value) => value as { pong: boolean }),
        ),
      );
      expect(ping.pong).toEqual(true);

      const written = yield* untilOk(
        HttpClient.get(`${deployed.api.url}/set`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`api returned ${res.status}`)),
          ),
          Effect.map((value) => value as { ok: boolean }),
        ),
      );
      expect(written.ok).toEqual(true);

      const read = yield* untilOk(
        HttpClient.get(`${deployed.api.url}/get`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(new Error(`api returned ${res.status}`)),
          ),
          Effect.map((value) => value as { ok: boolean; value: string }),
        ),
      );
      expect(read.ok).toEqual(true);
      expect(read.value).toEqual(REDIS_VALUE);

      yield* stack.destroy();

      const redisGone = yield* waitUntilRedisGone(
        deployed.cache.redisId,
        deployed.cache.name,
      );
      expect(redisGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(deployed.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "create redis on a fixed plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const plans = yield* Fly.listRedisPlans();
      const fixed = plans.find((plan) => Fly.isFixedRedisPlan(plan));
      expect(fixed).toBeDefined();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.Redis("FixedCache", {
            plan: fixed!.id,
          });
        }),
      );

      expect(created.planId).toEqual(fixed!.id);

      yield* stack.destroy();

      const gone = yield* waitUntilRedisGone(created.redisId, created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
