import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
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

const waitUntilGone = (name: string) =>
  developerconnect.getProjectsLocationsInsightsConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsInsightsConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.getProjectsLocationsInsightsConfigs({
          name: `projects/${project}/locations/us-central1/insightsConfigs/alchemy-missing-insights`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, replace, and delete an insights config",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.InsightsConfig("Sdlc", {
            location: "us-central1",
            projects: { projectIds: [project] },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.insightsConfigId).toEqual(expect.any(String));
      expect(created.name).toContain("/insightsConfigs/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* developerconnect.getProjectsLocationsInsightsConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.InsightsConfig("Sdlc", {
            insightsConfigId: created.insightsConfigId,
            location: "us-central1",
            projects: { projectIds: [project] },
            labels: { env: "prod", role: "sdlc" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "sdlc" });

      const fetchedUpdate =
        yield* developerconnect.getProjectsLocationsInsightsConfigs({
          name: updated.name,
        });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("sdlc");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DeveloperConnect.InsightsConfig("Sdlc", {
            insightsConfigId: created.insightsConfigId,
            location: "us-east1",
            projects: { projectIds: [project] },
            labels: { env: "test" },
          });
        }),
      );

      expect(replaced.insightsConfigId).toEqual(created.insightsConfigId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/");
      expect(replaced.name).not.toEqual(created.name);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 300_000,
  },
);
