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
    .getProjectsLocationsDatasetsConsentStoresAttributeDefinitions({ name })
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
  "getProjectsLocationsDatasetsConsentStoresAttributeDefinitions on a missing definition fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsConsentStoresAttributeDefinitions(
          {
            name: `projects/${project}/locations/us-central1/datasets/missing/consentStores/missing/attributeDefinitions/alchemy_missing`,
          },
        ),
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
  "create, update, and delete an attribute definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("AttrClinic", {
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            labels: { env: "test" },
          });
          const attr =
            yield* GCP.Healthcare.DatasetsConsentStoresAttributeDefinition(
              "DataType",
              {
                consentStore: store.name,
                category: "RESOURCE",
                allowedValues: ["fhir", "dicom"],
                description: "data modality",
              },
            );
          return { dataset, store, attr };
        }),
      );

      expect(created.attr.name).toContain("/attributeDefinitions/");
      expect(created.attr.category).toEqual("RESOURCE");
      expect(created.attr.allowedValues).toEqual(["fhir", "dicom"]);
      expect(created.attr.description).toEqual("data modality");

      const fetched =
        yield* healthcare.getProjectsLocationsDatasetsConsentStoresAttributeDefinitions(
          {
            name: created.attr.name,
          },
        );
      expect(fetched.name).toEqual(created.attr.name);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.allowedValues).toEqual(["fhir", "dicom"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("AttrClinic", {
            datasetId: created.dataset.datasetId,
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            consentStoreId: created.store.consentStoreId,
            labels: { env: "test" },
          });
          const attr =
            yield* GCP.Healthcare.DatasetsConsentStoresAttributeDefinition(
              "DataType",
              {
                consentStore: store.name,
                attributeDefinitionId: created.attr.attributeDefinitionId,
                category: "RESOURCE",
                allowedValues: ["fhir", "dicom", "hl7"],
                description: "data modality expanded",
              },
            );
          return { dataset, store, attr };
        }),
      );

      expect(updated.attr.name).toEqual(created.attr.name);
      expect(updated.attr.allowedValues).toEqual(["fhir", "dicom", "hl7"]);
      expect(updated.attr.description).toEqual("data modality expanded");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.attr.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
