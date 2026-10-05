import { Query } from "@distilled.cloud/core/query";
import { Railway as RailwayApi } from "@distilled.cloud/railway";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { suitePartition } from "../suiteProject.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const origin = Effect.gen(function* () {
  const { project, environment } = yield* suitePartition;
  // A public domain must exist before Railway can enable CDN caching.
  const service = yield* Railway.Service("Origin", {
    project,
    environment,
    image: "nginx:alpine",
    port: 80,
    healthcheckPath: "/",
  });
  return { project, environment, service };
});

const readConfig = Query.fn((serviceId: string, environmentId: string) => ({
  edgeConfig: RailwayApi.serviceInstance({
    serviceId,
    environmentId,
  }).edgeConfig.pipe(
    Query.map((config) => ({
      id: config.id,
      enabled: config.enabled,
      caching: config.caching.pipe(
        Query.map((caching) => ({
          mode: caching.mode,
          htmlCaching: caching.htmlCaching,
          purgeOnDeploy: caching.purgeOnDeploy,
          defaultTtlSeconds: caching.defaultTtlSeconds,
        })),
      ),
    })),
  ),
}));

const readCachingState = Query.fn(
  (serviceId: string, environmentId: string) => {
    const instance = RailwayApi.serviceInstance({ serviceId, environmentId });
    return {
      serviceId: instance.serviceId,
      edgeConfig: instance.edgeConfig.pipe(
        Query.map((config) => ({
          enabled: config.enabled,
          caching: config.caching.pipe(
            Query.map((caching) => ({ mode: caching.mode })),
          ),
        })),
      ),
    };
  },
);

test.provider(
  "enable, update, and disable CDN while retaining its origin",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const resources = yield* origin;
          const cdn = yield* Railway.Website.Cdn("Cache", {
            service: resources.service,
            environment: resources.environment,
            htmlCaching: "AUTO",
            purgeOnDeploy: "HTML",
            defaultTtlSeconds: 60,
          });
          return { ...resources, cdn };
        }),
      );

      expect(created.service.domain).toEqual(expect.any(String));
      expect(created.cdn.enabled).toEqual(true);
      const initial = yield* readConfig(
        created.service.serviceId,
        created.environment.environmentId,
      );
      expect(initial.edgeConfig?.id).toEqual(created.cdn.edgeConfigId);
      expect(initial.edgeConfig?.enabled).toEqual(true);
      expect(initial.edgeConfig?.caching?.mode.toLowerCase()).not.toEqual(
        "off",
      );
      expect(initial.edgeConfig?.caching?.htmlCaching).toEqual("auto");
      expect(initial.edgeConfig?.caching?.purgeOnDeploy).toEqual("HTML");
      expect(initial.edgeConfig?.caching?.defaultTtlSeconds).toEqual(60);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const resources = yield* origin;
          const cdn = yield* Railway.Website.Cdn("Cache", {
            service: resources.service,
            environment: resources.environment,
            htmlCaching: "FORCE",
            purgeOnDeploy: "ALL",
            defaultTtlSeconds: 120,
          });
          return { ...resources, cdn };
        }),
      );

      expect(updated.service.serviceId).toEqual(created.service.serviceId);
      expect(updated.cdn.edgeConfigId).toEqual(created.cdn.edgeConfigId);
      expect(updated.cdn.enabled).toEqual(true);
      const changed = yield* readConfig(
        updated.service.serviceId,
        updated.environment.environmentId,
      );
      expect(changed.edgeConfig?.enabled).toEqual(true);
      expect(changed.edgeConfig?.caching?.mode.toLowerCase()).not.toEqual(
        "off",
      );
      expect(changed.edgeConfig?.caching?.htmlCaching).toEqual("force");
      expect(changed.edgeConfig?.caching?.purgeOnDeploy).toEqual("ALL");
      expect(changed.edgeConfig?.caching?.defaultTtlSeconds).toEqual(120);

      // Keep both dependencies deployed so this step tests CDN deletion alone.
      const retained = yield* stack.deploy(origin);
      expect(retained.service.serviceId).toEqual(created.service.serviceId);
      expect(retained.environment.environmentId).toEqual(
        created.environment.environmentId,
      );

      const disabled = yield* readCachingState(
        retained.service.serviceId,
        retained.environment.environmentId,
      ).pipe(
        Effect.map((instance) => ({
          serviceId: instance.serviceId,
          // Edge routing can stay enabled after CDN caching is switched off.
          cachingEnabled:
            instance.edgeConfig?.enabled === true &&
            instance.edgeConfig.caching != null &&
            instance.edgeConfig.caching.mode.toLowerCase() !== "off",
        })),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (observed) => !observed.cachingEnabled,
          times: 10,
        }),
      );
      expect(disabled.serviceId).toEqual(retained.service.serviceId);
      expect(disabled.cachingEnabled).toEqual(false);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "provider:railway:website",
      "live",
    ],
    timeout: 120_000,
  },
);
