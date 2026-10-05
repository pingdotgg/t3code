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
    .getProjectsLocationsDatasetsConsentStoresConsentArtifacts({ name })
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
  "getProjectsLocationsDatasetsConsentStoresConsentArtifacts on a missing artifact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsConsentStoresConsentArtifacts({
          name: `projects/${project}/locations/us-central1/datasets/missing/consentStores/missing/consentArtifacts/alchemy-missing`,
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
  "create and delete a consent artifact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("ArtifactClinic", {
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            labels: { env: "test" },
          });
          const artifact =
            yield* GCP.Healthcare.DatasetsConsentStoresConsentArtifact(
              "Proof",
              {
                consentStore: store.name,
                userId: "user-123",
                consentContentVersion: "v1",
                metadata: { locale: "en" },
              },
            );
          return { dataset, store, artifact };
        }),
      );

      expect(created.artifact.name).toContain("/consentArtifacts/");
      expect(created.artifact.userId).toEqual("user-123");
      expect(created.artifact.consentContentVersion).toEqual("v1");
      expect(created.artifact.metadata).toMatchObject({ locale: "en" });

      const fetched =
        yield* healthcare.getProjectsLocationsDatasetsConsentStoresConsentArtifacts(
          {
            name: created.artifact.name,
          },
        );
      expect(fetched.name).toEqual(created.artifact.name);
      expect(fetched.userId).toEqual("user-123");
      expect(fetched.metadata?.locale).toEqual("en");
      expect(fetched.metadata?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("ArtifactClinic", {
            datasetId: created.dataset.datasetId,
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            consentStoreId: created.store.consentStoreId,
            labels: { env: "test" },
          });
          const artifact =
            yield* GCP.Healthcare.DatasetsConsentStoresConsentArtifact(
              "Proof",
              {
                consentStore: store.name,
                userId: "user-123",
                consentContentVersion: "v1",
                metadata: { locale: "en" },
              },
            );
          return { dataset, store, artifact };
        }),
      );

      expect(updated.artifact.name).toEqual(created.artifact.name);
      expect(updated.artifact.userId).toEqual("user-123");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.artifact.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
