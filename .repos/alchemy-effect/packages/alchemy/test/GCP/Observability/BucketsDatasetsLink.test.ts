import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as observability from "@distilled.cloud/gcp/observability_v1";
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
  observability.getProjectsLocationsBucketsDatasetsLinks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// The `_Trace` bucket and its `Spans` dataset only exist once the project
// stores trace data in Observability; until then create fails with
// BadRequest ("Unable to create link; parent bucket of … is not found").
// Set GCP_TEST_OBSERVABILITY_DATASET to an existing dataset name.
const spansDataset = process.env.GCP_TEST_OBSERVABILITY_DATASET;

test.provider(
  "getProjectsLocationsBucketsDatasetsLinks on a missing link fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const defaultDataset = `projects/${project}/locations/us-central1/buckets/_Trace/datasets/Spans`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        observability.getProjectsLocationsBucketsDatasetsLinks({
          name: `${defaultDataset}/links/alchemy-missing-link`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:observability", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!spansDataset)(
  "createProjectsLocationsBucketsDatasetsLinks without trace storage fails with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        observability.createProjectsLocationsBucketsDatasetsLinks({
          parent: `projects/${project}/locations/us-central1/buckets/_Trace/datasets/Spans`,
          linkId: "alchemy_probe_link",
          body: {},
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("parent bucket");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:observability", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!spansDataset)(
  "create, update, and delete an observability dataset link",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const dataset = spansDataset!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Observability.BucketsDatasetsLink("Analytics", {
            dataset,
            description: "bigquery analytics",
            displayName: "Trace analytics",
          });
        }),
      );

      expect(created.linkId).toEqual(expect.any(String));
      expect(created.linkId).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(created.dataset).toEqual(dataset);
      expect(created.project).toEqual(project);
      expect(created.name).toEqual(`${dataset}/links/${created.linkId}`);
      expect(created.description).toEqual("bigquery analytics");
      expect(created.displayName).toEqual("Trace analytics");

      const fetched =
        yield* observability.getProjectsLocationsBucketsDatasetsLinks({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("bigquery analytics");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Observability.BucketsDatasetsLink("Analytics", {
            dataset,
            linkId: created.linkId,
            description: "updated analytics",
            displayName: "Updated traces",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated analytics");
      expect(updated.displayName).toEqual("Updated traces");

      const fetchedUpdate =
        yield* observability.getProjectsLocationsBucketsDatasetsLinks({
          name: created.name,
        });
      expect(fetchedUpdate.description).toContain("updated analytics");
      expect(fetchedUpdate.displayName).toEqual("Updated traces");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:observability", "live"],
    timeout: 120_000,
  },
);
