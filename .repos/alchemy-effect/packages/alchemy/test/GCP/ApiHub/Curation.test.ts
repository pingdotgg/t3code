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

const endpointOf = (project: string) => ({
  applicationIntegrationEndpointDetails: {
    uri: `https://integrations.googleapis.com/v1/projects/${project}/locations/${location}/integrations/alchemy-curate:execute`,
    triggerId: "api_trigger/alchemy-curate",
  },
});

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsCurations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsCurations on a missing curation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsCurations({
          name: `projects/${project}/locations/${location}/curations/alchemy-missing-curation`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub curation",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const endpoint = endpointOf(project);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.Curation("Curate", {
            location,
            displayName: "curate-apis",
            description: "curate metadata",
            endpoint,
          });
        }),
      );

      expect(created.name).toContain("/curations/");
      expect(created.curationId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("curate-apis");
      expect(created.description).toEqual("curate metadata");
      expect(
        created.endpoint?.applicationIntegrationEndpointDetails.triggerId,
      ).toEqual("api_trigger/alchemy-curate");

      const fetched = yield* apihub.getProjectsLocationsCurations({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiHub.Curation("Curate", {
            curationId: created.curationId,
            location,
            displayName: "curate-apis-v2",
            description: "curate metadata v2",
            endpoint,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("curate-apis-v2");
      expect(updated.description).toEqual("curate metadata v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);
