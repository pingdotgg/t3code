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
// per run) and need TPU quota; set
// GCP_TEST_TPU=1 to opt in.
const runLifecycle = !!process.env.GCP_TEST_TPU && !process.env.FAST;

const waitUntilGone = (name: string) =>
  tpu.getProjectsLocationsQueuedResources({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsQueuedResources on a missing resource fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tpu.getProjectsLocationsQueuedResources({
          name: `projects/${project}/locations/us-central1-c/queuedResources/alchemy-tpu-qr-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:tpu", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a TPU queued resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.TPU.QueuedResource("Trainer", {
            location: "us-central1-c",
            nodeSpec: [
              {
                node: {
                  acceleratorType: "v2-8",
                  runtimeVersion: "tpu-ubuntu2204-base",
                  description: "alchemy-test-qr",
                  labels: { env: "test" },
                },
              },
            ],
          });
        }),
      );

      expect(created.name).toContain("/queuedResources/");
      expect(created.queuedResourceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1-c");
      expect(created.nodeSpec.length).toBeGreaterThan(0);
      expect(created.nodeSpec[0]?.node?.acceleratorType).toEqual("v2-8");
      expect(created.nodeSpec[0]?.node?.description).toEqual("alchemy-test-qr");
      expect(created.nodeSpec[0]?.node?.labels).toMatchObject({ env: "test" });

      const fetched = yield* tpu.getProjectsLocationsQueuedResources({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.tpu?.nodeSpec?.[0]?.node?.acceleratorType).toEqual("v2-8");
      expect(fetched.tpu?.nodeSpec?.[0]?.node?.labels?.env).toEqual("test");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:tpu", "live"], timeout: 120_000 },
);
