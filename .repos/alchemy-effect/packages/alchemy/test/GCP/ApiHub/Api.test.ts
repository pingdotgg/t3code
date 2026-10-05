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
  apihub.getProjectsLocationsApis({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsApis on a missing API fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsApis({
          name: `projects/${project}/locations/${location}/apis/alchemy-missing-api`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.Api("Pets", {
            location,
            displayName: "pets",
            description: "pet store",
          });
        }),
      );

      expect(created.name).toContain("/apis/");
      expect(created.apiId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("pets");
      expect(created.description).toEqual("pet store");

      const fetched = yield* apihub.getProjectsLocationsApis({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("pets");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("pet store");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.Api("Pets", {
            apiId: created.apiId,
            location,
            displayName: "pets-v2",
            description: "pet store v2",
            documentation: { externalUri: "https://example.com/pets" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("pets-v2");
      expect(updated.description).toEqual("pet store v2");
      expect(updated.documentation?.externalUri).toEqual(
        "https://example.com/pets",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);
