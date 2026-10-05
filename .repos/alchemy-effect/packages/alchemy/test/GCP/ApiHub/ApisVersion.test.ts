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

// Needs a provisioned API Hub instance in us-central1 (one per project,
// behind a host project registration); without one writes fail with
// BadRequest ("Invalid resource state … API Hub instance …"). Set
// GCP_TEST_APIHUB_INSTANCE=1 when the hub exists.
const runLifecycle = !!process.env.GCP_TEST_APIHUB_INSTANCE;
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsApisVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsApisVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsApisVersions({
          name: `projects/${project}/locations/${location}/apis/alchemy-missing/versions/v1`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.ApiHub.Api("Pets", {
            location,
            displayName: "pets",
          });
          const version = yield* GCP.ApiHub.ApisVersion("V1", {
            api: api.name,
            location,
            displayName: "v1",
            description: "first cut",
          });
          return { api, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.api).toEqual(created.api.name);
      expect(created.version.displayName).toEqual("v1");
      expect(created.version.description).toEqual("first cut");

      const fetched = yield* apihub.getProjectsLocationsApisVersions({
        name: created.version.name,
      });
      expect(fetched.name).toEqual(created.version.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("first cut");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.ApiHub.Api("Pets", {
            apiId: created.api.apiId,
            location,
            displayName: "pets",
          });
          const version = yield* GCP.ApiHub.ApisVersion("V1", {
            api: api.name,
            versionId: created.version.versionId,
            location,
            displayName: "v1-prod",
            description: "stable",
            documentation: { externalUri: "https://example.com/v1" },
          });
          return { api, version };
        }),
      );

      expect(updated.version.name).toEqual(created.version.name);
      expect(updated.version.displayName).toEqual("v1-prod");
      expect(updated.version.description).toEqual("stable");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);
