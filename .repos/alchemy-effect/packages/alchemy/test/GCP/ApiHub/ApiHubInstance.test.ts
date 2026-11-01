import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apihub from "@distilled.cloud/gcp/apihub_v1";
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

// API Hub needs a host project registration first; without it instance
// create fails with BadRequest ("Unable to find host project registration
// for this project."). Set GCP_TEST_APIHUB_HOST_PROJECT=1 on a registered
// project that has no hub yet (one instance per project).
const runLifecycle = !!process.env.GCP_TEST_APIHUB_HOST_PROJECT;
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsApiHubInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsApiHubInstances on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsApiHubInstances({
          name: `projects/${project}/locations/${location}/apiHubInstances/alchemy-missing-hub`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsApiHubInstances without a host project registration fails with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.createProjectsLocationsApiHubInstances({
          parent: `projects/${project}/locations/${location}`,
          apiHubInstanceId: "alchemy-apihub-probe",
          body: { config: { vertexLocation: "us" } },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("host project registration");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.ApiHubInstance("Hub", {
            location,
            description: "alchemy test hub",
            labels: { env: "test" },
            config: { disableSearch: false, vertexLocation: "us" },
          });
        }),
      );

      expect(created.name).toContain("/apiHubInstances/");
      expect(created.apiHubInstanceId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.description).toEqual("alchemy test hub");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* apihub.getProjectsLocationsApiHubInstances({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.ApiHubInstance("Hub", {
            apiHubInstanceId: created.apiHubInstanceId,
            location,
            description: "alchemy test hub v2",
            labels: { env: "prod" },
            config: {
              disableSearch: true,
              vertexLocation: "us",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.disableSearch).toEqual(true);
      expect(updated.vertexLocation).toEqual("us");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 120_000 },
);
