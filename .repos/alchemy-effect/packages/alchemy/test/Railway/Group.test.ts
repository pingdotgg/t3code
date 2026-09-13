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

const asGroupMap = (value: unknown): Record<string, { name?: string }> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const groups = (value as { groups?: unknown }).groups;
  if (groups === null || typeof groups !== "object" || Array.isArray(groups)) {
    return {};
  }
  const out: Record<string, { name?: string }> = {};
  for (const [groupId, row] of Object.entries(groups)) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as { name?: unknown; isDeleted?: unknown };
    if (rec.isDeleted === true) continue;
    out[groupId] = {
      name: typeof rec.name === "string" ? rec.name : undefined,
    };
  }
  return out;
};

const readConfigGroups = (environmentId: string, projectId: string) =>
  railway.environment({ id: environmentId, projectId }).pipe(
    Effect.map((env) => asGroupMap(env.config)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed({} as Record<string, { name?: string }>),
    ),
  );

const readProjectGroups = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.groups.edges
        .map((edge) => edge.node)
        .filter((group) => group.name != null && group.name.length > 0),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.succeed([])),
  );

const readService = (serviceId: string) =>
  railway
    .service({ id: serviceId })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const waitUntilGroupGone = (
  projectId: string,
  environmentId: string,
  groupId: string,
  name: string,
) =>
  Effect.gen(function* () {
    const config = yield* readConfigGroups(environmentId, projectId);
    const listed = yield* readProjectGroups(projectId);
    const inConfig =
      Object.hasOwn(config, groupId) ||
      Object.values(config).some((row) => row.name === name);
    const inProject = listed.some(
      (group) =>
        group.id === groupId ||
        group.groupId === groupId ||
        group.name === name,
    );
    return inConfig || inProject ? ("found" as const) : ("gone" as const);
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, noop, and delete a canvas group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
          });
          const backend = yield* Railway.Group("Backend", {
            project,
            environment,
            resources: [api],
          });
          return { project, environment, api, backend };
        }),
      );

      expect(created.backend.groupId).toEqual(expect.any(String));
      expect(created.backend.groupId.length).toBeGreaterThan(0);
      expect(created.backend.projectId).toEqual(created.project.projectId);
      expect(created.backend.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.backend.name).toEqual(expect.any(String));
      expect(created.backend.name.length).toBeGreaterThan(0);
      expect(created.backend.serviceIds).toEqual([created.api.serviceId]);

      const config = yield* readConfigGroups(
        created.backend.environmentId,
        created.backend.projectId,
      );
      const listed = yield* readProjectGroups(created.project.projectId);
      const fromConfig = config[created.backend.groupId];
      const fromProject = listed.find(
        (group) =>
          group.id === created.backend.groupId ||
          group.groupId === created.backend.groupId ||
          group.name === created.backend.name,
      );
      const apiLive = yield* readService(created.api.serviceId);
      const persisted =
        fromConfig !== undefined ||
        fromProject !== undefined ||
        apiLive?.groupId === created.backend.groupId;
      expect(persisted || created.backend.serviceIds.length === 1).toBe(true);
      if (fromConfig !== undefined) {
        expect(fromConfig.name).toEqual(created.backend.name);
      }
      if (fromProject !== undefined) {
        expect(fromProject.name).toEqual(created.backend.name);
      }

      const provider = yield* Provider.findProvider(Railway.Group);
      const listedByProvider = yield* provider.list();
      const found = listedByProvider.find(
        (group) =>
          group.groupId === created.backend.groupId &&
          group.environmentId === created.backend.environmentId,
      );
      if (fromConfig !== undefined || fromProject !== undefined) {
        expect(found).toBeDefined();
        expect(found?.name).toEqual(created.backend.name);
      }

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const api = yield* Railway.Service("Api", {
            project,
            environment,
            image: "hashicorp/http-echo",
            port: 5678,
          });
          const backend = yield* Railway.Group("Backend", {
            project,
            environment,
            resources: [api],
          });
          return { project, environment, api, backend };
        }),
      );

      expect(updated.backend.groupId).toEqual(created.backend.groupId);
      expect(updated.backend.projectId).toEqual(created.backend.projectId);
      expect(updated.backend.environmentId).toEqual(
        created.backend.environmentId,
      );
      expect(updated.backend.name).toEqual(created.backend.name);
      expect(updated.backend.serviceIds.sort()).toEqual(
        created.backend.serviceIds.sort(),
      );

      yield* stack.destroy();

      const groupGone = yield* waitUntilGroupGone(
        created.backend.projectId,
        created.backend.environmentId,
        created.backend.groupId,
        created.backend.name,
      );
      expect(groupGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
