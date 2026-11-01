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
  healthcare.getProjectsLocationsDatasetsConsentStoresConsents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDatasetsConsentStoresConsents on a missing consent fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsConsentStoresConsents({
          name: `projects/${project}/locations/us-central1/datasets/missing/consentStores/missing/consents/alchemy-missing`,
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
  "create, update, and delete a consent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("ConsentClinic", {
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
              },
            );
          const consent = yield* GCP.Healthcare.DatasetsConsentStoresConsent(
            "Grant",
            {
              consentStore: store.name,
              userId: "user-123",
              consentArtifact: artifact.name,
              state: "DRAFT",
              metadata: { source: "app" },
            },
          );
          return { dataset, store, artifact, consent };
        }),
      );

      expect(created.consent.name).toContain("/consents/");
      expect(created.consent.userId).toEqual("user-123");
      expect(created.consent.state).toEqual("DRAFT");
      expect(created.consent.metadata).toMatchObject({ source: "app" });

      const fetched =
        yield* healthcare.getProjectsLocationsDatasetsConsentStoresConsents({
          name: created.consent.name,
        });
      expect(fetched.name).toEqual(created.consent.name);
      expect(fetched.state).toEqual("DRAFT");
      expect(fetched.metadata?.source).toEqual("app");
      expect(fetched.metadata?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("ConsentClinic", {
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
              },
            );
          const consent = yield* GCP.Healthcare.DatasetsConsentStoresConsent(
            "Grant",
            {
              consentStore: store.name,
              userId: "user-123",
              consentArtifact: artifact.name,
              state: "DRAFT",
              metadata: { source: "portal" },
            },
          );
          return { dataset, store, artifact, consent };
        }),
      );

      expect(updated.consent.name).toEqual(created.consent.name);
      expect(updated.consent.metadata).toMatchObject({ source: "portal" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.consent.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
