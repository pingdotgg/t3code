import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const projectNameOf = (project: string) => `projects/${project}`;

const waitUntilGone = (name: string) =>
  logging.getProjectsLocationsLogScopes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a logging log scope",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.LogScope("App", {
            resourceNames: [projectNameOf(project)],
            description: "application logs",
          });
        }),
      );

      expect(created.logScopeId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(
        `projects/${project}/locations/global/logScopes/${created.logScopeId}`,
      );
      expect(created.resourceNames).toEqual([projectNameOf(project)]);
      expect(created.description).toEqual("application logs");

      const fetched = yield* logging.getProjectsLocationsLogScopes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.resourceNames).toEqual([projectNameOf(project)]);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("application logs");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.LogScope("App", {
            logScopeId: created.logScopeId,
            resourceNames: [projectNameOf(project)],
            description: "all application logs",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.logScopeId).toEqual(created.logScopeId);
      expect(updated.description).toEqual("all application logs");
      expect(updated.createTime).toEqual(created.createTime);

      const fetchedUpdate = yield* logging.getProjectsLocationsLogScopes({
        name: created.name,
      });
      expect(fetchedUpdate.description).toContain("all application logs");

      const last = created.logScopeId.at(-1) ?? "a";
      const nextLogScopeId = `${created.logScopeId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.LogScope("App", {
            logScopeId: nextLogScopeId,
            resourceNames: [projectNameOf(project)],
            description: "replaced scope",
          });
        }),
      );

      expect(replaced.logScopeId).not.toEqual(created.logScopeId);
      expect(replaced.name).toEqual(
        `projects/${project}/locations/global/logScopes/${replaced.logScopeId}`,
      );
      expect(replaced.description).toEqual("replaced scope");

      const fetchedReplacement = yield* logging.getProjectsLocationsLogScopes({
        name: replaced.name,
      });
      expect(fetchedReplacement.name).toEqual(replaced.name);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);
