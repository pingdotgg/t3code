import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as metastore from "@distilled.cloud/gcp/metastore_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { isServiceEnabled } from "../ServiceState.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "getProjectsLocationsServices on a missing service fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsServices({
          name: `projects/${project}/locations/us-central1/services/alchemy-missing-service`,
        }),
      );
      expect(["ServiceDisabled", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 90_000 },
);

test.provider(
  "create is rejected when the Dataproc Metastore API is disabled",
  (stack) =>
    Effect.gen(function* () {
      // Only meaningful while the API is disabled: enabled, the create would
      // provision a real resource.
      if (yield* isServiceEnabled("metastore.googleapis.com")) return;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Metastore.Service("Hive", {
              location: "us-central1",
              hiveMetastoreConfig: { version: "3.1.2" },
              tier: "DEVELOPER",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:metastore", "live"], timeout: 90_000 },
);
