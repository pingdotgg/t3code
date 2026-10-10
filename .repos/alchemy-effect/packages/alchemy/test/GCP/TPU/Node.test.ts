import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as tpu from "@distilled.cloud/gcp/tpu_v2";
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

// Cloud TPU is disabled on the testing project (ServiceDisabled "Cloud TPU API
// has not been used in project ...") and TPU VMs bill by the hour (dollars
// per run), need TPU quota, and take
// several minutes to provision; set GCP_TEST_TPU=1 to opt in.
const runLifecycle = !!process.env.GCP_TEST_TPU && !process.env.FAST;

const waitUntilGone = (name: string) =>
  tpu.getProjectsLocationsNodes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsNodes on a missing node fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tpu.getProjectsLocationsNodes({
          name: `projects/${project}/locations/us-central1-c/nodes/alchemy-tpu-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:tpu", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a TPU node",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.TPU.Node("Trainer", {
            location: "us-central1-c",
            acceleratorType: "v2-8",
            runtimeVersion: "tpu-ubuntu2204-base",
            description: "alchemy-test-tpu",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/nodes/");
      expect(created.nodeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1-c");
      expect(created.acceleratorType).toEqual("v2-8");
      expect(created.description).toEqual("alchemy-test-tpu");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* tpu.getProjectsLocationsNodes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.acceleratorType).toEqual("v2-8");
      expect(fetched.description).toEqual("alchemy-test-tpu");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.TPU.Node("Trainer", {
            nodeId: created.nodeId,
            location: "us-central1-c",
            acceleratorType: "v2-8",
            runtimeVersion: "tpu-ubuntu2204-base",
            description: "alchemy-prod-tpu",
            labels: { env: "prod", role: "tpu" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-tpu");
      expect(updated.labels).toMatchObject({ env: "prod", role: "tpu" });

      const refetched = yield* tpu.getProjectsLocationsNodes({
        name: created.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-tpu");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("tpu");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:tpu", "live"], timeout: 120_000 },
);
