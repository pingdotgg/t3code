import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as healthcare from "@distilled.cloud/gcp/healthcare_v1";
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
  healthcare.getProjectsLocationsDatasetsFhirStores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDatasetsFhirStores on a missing store fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsFhirStores({
          name: `projects/${project}/locations/us-central1/datasets/missing/fhirStores/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a FHIR store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("Records", {
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsFhirStore("Fhir", {
            dataset: dataset.name,
            version: "R4",
            labels: { env: "test" },
          });
          return { dataset, store };
        }),
      );

      expect(created.store.name).toContain("/fhirStores/");
      expect(created.store.version).toEqual("R4");
      expect(created.store.enableUpdateCreate).toEqual(false);
      expect(created.store.labels).toMatchObject({ env: "test" });

      const fetched = yield* healthcare.getProjectsLocationsDatasetsFhirStores({
        name: created.store.name,
      });
      expect(fetched.name).toEqual(created.store.name);
      expect(fetched.version).toEqual("R4");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("Records", {
            datasetId: created.dataset.datasetId,
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsFhirStore("Fhir", {
            dataset: dataset.name,
            fhirStoreId: created.store.fhirStoreId,
            version: "R4",
            enableUpdateCreate: true,
            labels: { env: "prod", role: "fhir" },
          });
          return { dataset, store };
        }),
      );

      expect(updated.store.name).toEqual(created.store.name);
      expect(updated.store.enableUpdateCreate).toEqual(true);
      expect(updated.store.labels).toMatchObject({ env: "prod", role: "fhir" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.store.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
