import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suiteProject } from "./suiteProject.ts";
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

const waitUntilEnvGone = (environmentId: string) =>
  railway.environment({ id: environmentId }).pipe(
    Effect.map((env) =>
      env.deletedAt != null ? ("gone" as const) : ("found" as const),
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
  "create, update, list, and delete an extra environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* suiteProject;
          const environment = yield* Railway.Environment("Staging", {
            project,
          });
          return { project, environment };
        }),
      );

      expect(created.project.projectId).toEqual(expect.any(String));
      expect(created.project.environmentId).toEqual(expect.any(String));
      expect(created.environment.environmentId).toEqual(expect.any(String));
      expect(created.environment.environmentId.length).toBeGreaterThan(0);
      expect(created.environment.environmentId).not.toEqual(
        created.project.environmentId,
      );
      expect(created.environment.projectId).toEqual(created.project.projectId);
      expect(created.environment.name).toEqual(expect.any(String));
      expect(created.environment.name.length).toBeGreaterThan(0);
      expect(created.environment.name.length).toBeLessThanOrEqual(32);
      expect(created.environment.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.environment.isEphemeral).toEqual(false);
      expect(created.environment.url).toEqual(
        `https://railway.com/project/${created.project.projectId}?environmentId=${created.environment.environmentId}`,
      );

      const fetched = yield* railway.environment({
        id: created.environment.environmentId,
        projectId: created.project.projectId,
      });
      expect(fetched.id).toEqual(created.environment.environmentId);
      expect(fetched.name).toEqual(created.environment.name);
      expect(fetched.projectId).toEqual(created.project.projectId);
      expect(fetched.deletedAt).toBeNull();

      const production = yield* railway.environment({
        id: created.project.environmentId,
        projectId: created.project.projectId,
      });
      expect(production.id).toEqual(created.project.environmentId);
      expect(production.deletedAt).toBeNull();

      const provider = yield* Provider.findProvider(Railway.Environment);
      const listed = yield* provider.list();
      const found = listed.find(
        (env) => env.environmentId === created.environment.environmentId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.environment.name);
      expect(found?.projectId).toEqual(created.project.projectId);
      expect(
        listed.find(
          (env) => env.environmentId === created.project.environmentId,
        ),
      ).toBeUndefined();

      const nextName =
        created.environment.name.slice(0, -1) +
        (created.environment.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* suiteProject;
          const environment = yield* Railway.Environment("Staging", {
            project,
            name: nextName,
          });
          return { project, environment };
        }),
      );

      expect(updated.project.projectId).toEqual(created.project.projectId);
      expect(updated.environment.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(updated.environment.name).toEqual(nextName);
      expect(updated.environment.projectId).toEqual(created.project.projectId);
      expect(updated.environment.environmentId).not.toEqual(
        updated.project.environmentId,
      );

      const fetchedUpdate = yield* railway.environment({
        id: updated.environment.environmentId,
        projectId: updated.project.projectId,
      });
      expect(fetchedUpdate.id).toEqual(updated.environment.environmentId);
      expect(fetchedUpdate.name).toEqual(nextName);

      yield* stack.destroy();

      const envGone = yield* waitUntilEnvGone(
        created.environment.environmentId,
      );
      expect(envGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);
