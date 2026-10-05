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
  healthcare.getProjectsLocationsDatasetsConsentStores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDatasetsConsentStores on a missing store fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsConsentStores({
          name: `projects/${project}/locations/us-central1/datasets/missing/consentStores/alchemy-missing`,
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
  "create, update, and delete a consent store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("Clinic", {
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            labels: { env: "test" },
          });
          return { dataset, store };
        }),
      );

      expect(created.store.name).toContain("/consentStores/");
      expect(created.store.dataset).toEqual(created.dataset.name);
      expect(created.store.labels).toMatchObject({ env: "test" });
      expect(created.store.enableConsentCreateOnUpdate).toEqual(false);

      const fetched =
        yield* healthcare.getProjectsLocationsDatasetsConsentStores({
          name: created.store.name,
        });
      expect(fetched.name).toEqual(created.store.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("Clinic", {
            datasetId: created.dataset.datasetId,
            location: "us-central1",
          });
          const store = yield* GCP.Healthcare.DatasetsConsentStore("Consents", {
            dataset: dataset.name,
            consentStoreId: created.store.consentStoreId,
            labels: { env: "prod", role: "consent" },
            enableConsentCreateOnUpdate: true,
          });
          return { dataset, store };
        }),
      );

      expect(updated.store.name).toEqual(created.store.name);
      expect(updated.store.enableConsentCreateOnUpdate).toEqual(true);
      expect(updated.store.labels).toMatchObject({
        env: "prod",
        role: "consent",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.store.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
