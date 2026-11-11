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
  "getProjectsLocationsFederations on a missing federation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        metastore.getProjectsLocationsFederations({
          name: `projects/${project}/locations/us-central1/federations/alchemy-missing-federation`,
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
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Metastore.Federation("Lakehouse", {
              location: "us-central1",
              version: "3.1.2",
              backendMetastores: {
                "1": {
                  name: `projects/${project}`,
                  metastoreType: "BIGQUERY",
                },
              },
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
