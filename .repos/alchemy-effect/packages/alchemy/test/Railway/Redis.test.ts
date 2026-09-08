import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const REDIS_VALUE = "alchemy-railway-redis";

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const readServiceVariables = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const waitUntilGone = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilProxyGone = (
  environmentId: string,
  serviceId: string,
  id: string,
) =>
  railway.tcpProxies({ environmentId, serviceId }).pipe(
    Effect.map((items) =>
      items.some(
        (proxy) =>
          proxy.id === id &&
          proxy.deletedAt == null &&
          proxy.syncStatus !== "DELETED",
      )
        ? ("found" as const)
        : ("gone" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, set/get via tcp proxy, update, list, and delete redis",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const cache = yield* Railway.Redis("Cache", { project, environment });
          const proxy = yield* Railway.TcpProxy("CacheProxy", {
            redis: cache,
            environment,
            applicationPort: Railway.REDIS_PORT,
          });
          return { project, environment, cache, proxy };
        }),
      );

      expect(created.cache.serviceId).toEqual(expect.any(String));
      expect(created.cache.serviceId.length).toBeGreaterThan(0);
      expect(created.cache.projectId).toEqual(created.project.projectId);
      expect(created.cache.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.cache.name).toEqual(expect.any(String));
      expect(created.cache.name.length).toBeGreaterThan(0);
      expect(created.cache.name.length).toBeLessThanOrEqual(32);
      expect(created.cache.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.cache.port).toEqual(6379);
      expect(created.cache.privateHost).toEqual(
        `${created.cache.name}.railway.internal`,
      );
      expect(created.cache.image).toEqual(expect.stringContaining("redis"));
      expect(created.proxy.applicationPort).toEqual(6379);
      expect(created.proxy.serviceId).toEqual(created.cache.serviceId);
      expect(created.proxy.domain).toEqual(expect.any(String));
      expect(created.proxy.proxyPort).toEqual(expect.any(Number));

      const fetched = yield* railway.service({ id: created.cache.serviceId });
      expect(fetched.id).toEqual(created.cache.serviceId);
      expect(fetched.name).toEqual(created.cache.name);
      expect(fetched.projectId).toEqual(created.cache.projectId);
      expect(fetched.deletedAt).toBeNull();

      const instance = yield* railway.serviceInstance({
        environmentId: created.cache.environmentId,
        serviceId: created.cache.serviceId,
      });
      expect(instance.serviceId).toEqual(created.cache.serviceId);
      expect(instance.source?.image).toEqual(expect.stringContaining("redis"));

      const vars = yield* readServiceVariables(
        created.cache.projectId,
        created.cache.environmentId,
        created.cache.serviceId,
      );
      const password = vars[Railway.REDIS_PASSWORD_ENV];
      expect(password !== undefined && password.length > 0).toEqual(true);
      expect(vars[Railway.REDIS_URL_ENV] !== undefined).toEqual(true);

      const url = Railway.redisConnectionUrl({
        host: created.proxy.domain,
        port: created.proxy.proxyPort,
        password: password!,
      });

      const pong = yield* Railway.runRedisCommand(url, "PING").pipe(
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
      );
      expect(String(pong).toUpperCase()).toContain("PONG");

      yield* Railway.runRedisCommand(url, "SET", ["marker", REDIS_VALUE]);
      const got = yield* Railway.runRedisCommand(url, "GET", ["marker"]);
      expect(got).toEqual(REDIS_VALUE);

      const provider = yield* Provider.findProvider(Railway.Redis);
      const listed = yield* provider.list();
      const found = listed.find(
        (row) => row.serviceId === created.cache.serviceId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.cache.name);
      expect(found?.projectId).toEqual(created.cache.projectId);

      const nextName =
        created.cache.name.slice(0, -1) +
        (created.cache.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const cache = yield* Railway.Redis("Cache", {
            project,
            environment,
            name: nextName,
          });
          const proxy = yield* Railway.TcpProxy("CacheProxy", {
            redis: cache,
            environment,
            applicationPort: Railway.REDIS_PORT,
          });
          return { project, environment, cache, proxy };
        }),
      );

      expect(updated.cache.serviceId).toEqual(created.cache.serviceId);
      expect(updated.cache.name).toEqual(nextName);
      expect(updated.cache.privateHost).toEqual(`${nextName}.railway.internal`);
      expect(updated.proxy.id).toEqual(created.proxy.id);

      const fetchedUpdate = yield* railway.service({
        id: updated.cache.serviceId,
      });
      expect(fetchedUpdate.name).toEqual(nextName);

      yield* stack.destroy();

      const proxyGone = yield* waitUntilProxyGone(
        created.environment.environmentId,
        created.cache.serviceId,
        created.proxy.id,
      );
      expect(proxyGone).toEqual("gone");
      const gone = yield* waitUntilGone(created.cache.serviceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
