import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
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

const waitUntilGone = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.deletedAt != null ? ("gone" as const) : ("found" as const),
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
  "create, update, list, and delete a project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Railway.Project("Site", {
            description: "v1",
          });
        }),
      );

      expect(created.projectId).toEqual(expect.any(String));
      expect(created.projectId.length).toBeGreaterThan(0);
      expect(created.name).toEqual(expect.any(String));
      expect(created.name.length).toBeGreaterThan(0);
      expect(created.name.length).toBeLessThanOrEqual(32);
      expect(created.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.workspaceId).toEqual(expect.any(String));
      expect(created.workspaceId.length).toBeGreaterThan(0);
      expect(created.environmentId).toEqual(expect.any(String));
      expect(created.environmentId.length).toBeGreaterThan(0);
      expect(created.url).toEqual(
        `https://railway.com/project/${created.projectId}`,
      );

      const fetched = yield* railway.project({ id: created.projectId });
      expect(fetched.id).toEqual(created.projectId);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("v1");
      expect(fetched.workspaceId).toEqual(created.workspaceId);

      const provider = yield* Provider.findProvider(Railway.Project);
      const listed = yield* provider.list();
      const found = listed.find(
        (project) => project.projectId === created.projectId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.name);
      expect(found?.url).toEqual(created.url);
      expect(found?.environmentId).toEqual(created.environmentId);

      const nextName =
        created.name.slice(0, -1) + (created.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Railway.Project("Site", {
            name: nextName,
            description: "v2",
          });
        }),
      );

      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.name).toEqual(nextName);
      expect(updated.workspaceId).toEqual(created.workspaceId);
      expect(updated.environmentId).toEqual(created.environmentId);
      expect(updated.url).toEqual(created.url);

      const fetchedUpdate = yield* railway.project({ id: updated.projectId });
      expect(fetchedUpdate.id).toEqual(updated.projectId);
      expect(fetchedUpdate.name).toEqual(nextName);
      expect(fetchedUpdate.description).toEqual("v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.projectId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
