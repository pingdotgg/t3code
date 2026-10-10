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
  healthcare.getProjectsLocationsDatasetsHl7V2Stores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDatasetsHl7V2Stores on a missing store fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsHl7V2Stores({
          name: `projects/${project}/locations/us-central1/datasets/missing/hl7V2Stores/alchemy-missing`,
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
  "create, update, and delete an HL7v2 store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("AdtClinic", {
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsHl7V2Store("Adt", {
            dataset: dataset.name,
            labels: { env: "test" },
          });
          return { dataset, store };
        }),
      );

      expect(created.store.name).toContain("/hl7V2Stores/");
      expect(created.store.rejectDuplicateMessage).toEqual(false);
      expect(created.store.labels).toMatchObject({ env: "test" });

      const fetched = yield* healthcare.getProjectsLocationsDatasetsHl7V2Stores(
        {
          name: created.store.name,
        },
      );
      expect(fetched.name).toEqual(created.store.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("AdtClinic", {
            datasetId: created.dataset.datasetId,
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsHl7V2Store("Adt", {
            dataset: dataset.name,
            hl7V2StoreId: created.store.hl7V2StoreId,
            rejectDuplicateMessage: true,
            labels: { env: "prod", role: "adt" },
          });
          return { dataset, store };
        }),
      );

      expect(updated.store.name).toEqual(created.store.name);
      expect(updated.store.rejectDuplicateMessage).toEqual(true);
      expect(updated.store.labels).toMatchObject({ env: "prod", role: "adt" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.store.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
