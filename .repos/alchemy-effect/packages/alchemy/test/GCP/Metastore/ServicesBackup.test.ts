import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as metastore from "@distilled.cloud/gcp/metastore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "getProjectsLocationsServicesBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsServicesBackups({
          name: `projects/${project}/locations/us-central1/services/alchemy-missing-service/backups/alchemy-missing-backup`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 90_000 },
);

test.provider(
  "create against a missing service is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Metastore.ServicesBackup("Nightly", {
              service: `projects/${project}/locations/us-central1/services/alchemy-missing-service`,
              description: "alchemy-test-backup",
            });
          }),
        ),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 90_000 },
);
