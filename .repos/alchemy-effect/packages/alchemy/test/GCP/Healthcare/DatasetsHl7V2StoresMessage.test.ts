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

const HL7 = [
  "MSH|^~\\&|ALCHEMY|TESTFAC|RECEIVER|RECVFAC|20240101120000||ADT^A01|MSG00001|P|2.5",
  "PID|1||PAT001^^^MR||DOE^JOHN",
].join("\r");

const waitUntilGone = (name: string) =>
  healthcare.getProjectsLocationsDatasetsHl7V2StoresMessages({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDatasetsHl7V2StoresMessages on a missing message fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        healthcare.getProjectsLocationsDatasetsHl7V2StoresMessages({
          name: `projects/${project}/locations/us-central1/datasets/alchemy-missing/hl7V2Stores/alchemy-missing/messages/alchemy-missing-hl7`,
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
  "create, update, and delete an HL7v2 message",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("Clinic", {});
          const store = yield* GCP.Healthcare.DatasetsHl7V2Store("AdtStore", {
            dataset: dataset.name,
          });
          const message = yield* GCP.Healthcare.DatasetsHl7V2StoresMessage(
            "Adt",
            {
              parent: store.name,
              data: HL7,
              labels: { env: "test" },
            },
          );
          return { dataset, store, message };
        }),
      );

      expect(created.message.messageId.length).toBeGreaterThan(0);
      expect(created.message.parent).toEqual(created.store.name);
      expect(created.message.name).toContain("/messages/");
      expect(created.message.data).toContain("ADT^A01");
      expect(created.message.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* healthcare.getProjectsLocationsDatasetsHl7V2StoresMessages({
          name: created.message.name,
          view: "FULL",
        });
      expect(fetched.name).toEqual(created.message.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Healthcare.Dataset("Clinic", {
            datasetId: created.dataset.datasetId,
            location: created.dataset.location,
          });
          const store = yield* GCP.Healthcare.DatasetsHl7V2Store("AdtStore", {
            dataset: dataset.name,
            hl7V2StoreId: created.store.hl7V2StoreId,
          });
          const message = yield* GCP.Healthcare.DatasetsHl7V2StoresMessage(
            "Adt",
            {
              parent: store.name,
              messageId: created.message.messageId,
              data: HL7,
              labels: { env: "prod", role: "adt" },
            },
          );
          return { dataset, store, message };
        }),
      );

      expect(updated.message.messageId).toEqual(created.message.messageId);
      expect(updated.message.labels).toMatchObject({
        env: "prod",
        role: "adt",
      });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.message.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:healthcare", "live"],
    timeout: 120_000,
  },
);
