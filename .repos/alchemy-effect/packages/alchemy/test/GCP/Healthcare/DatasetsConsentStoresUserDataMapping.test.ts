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
  healthcare
    .getProjectsLocationsDatasetsConsentStoresUserDataMappings({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsDatasetsConsentStoresUserDataMappings on a missing mapping fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsConsentStoresUserDataMappings({
          name: `projects/${project}/locations/us-central1/datasets/missing/consentStores/missing/userDataMappings/alchemy-missing`,
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
  "create, update, and delete a user data mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("MappingClinic", {
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            labels: { env: "test" },
          });
          const mapping =
            yield* GCP.Healthcare.DatasetsConsentStoresUserDataMapping(
              "Chart",
              {
                consentStore: store.name,
                userId: "user-123",
                dataId: "Patient/abc",
              },
            );
          return { dataset, store, mapping };
        }),
      );

      expect(created.mapping.name).toContain("/userDataMappings/");
      expect(created.mapping.userId).toEqual("user-123");
      expect(created.mapping.dataId).toEqual("Patient/abc");

      const fetched =
        yield* healthcare.getProjectsLocationsDatasetsConsentStoresUserDataMappings(
          {
            name: created.mapping.name,
          },
        );
      expect(fetched.name).toEqual(created.mapping.name);
      expect(fetched.userId).toEqual("user-123");
      expect(fetched.dataId).toContain("Patient/abc");
      expect(fetched.dataId?.startsWith("alc-")).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("MappingClinic", {
            datasetId: created.dataset.datasetId,
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            consentStoreId: created.store.consentStoreId,
            labels: { env: "test" },
          });
          const mapping =
            yield* GCP.Healthcare.DatasetsConsentStoresUserDataMapping(
              "Chart",
              {
                consentStore: store.name,
                userId: "user-123",
                dataId: "Patient/xyz",
              },
            );
          return { dataset, store, mapping };
        }),
      );

      expect(updated.mapping.name).toEqual(created.mapping.name);
      expect(updated.mapping.dataId).toEqual("Patient/xyz");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.mapping.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
