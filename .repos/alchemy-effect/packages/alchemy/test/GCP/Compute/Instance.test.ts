import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, zone: string, instance: string) =>
  compute.getInstances({ project, zone, instance }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Instance("Vm", {
            zone: "us-central1-a",
            machineType: "e2-micro",
            labels: { env: "test" },
            tags: ["alchemy-test"],
            metadata: { role: "test" },
            associatePublicIp: false,
          });
        }),
      );

      expect(created.instanceName).toEqual(expect.any(String));
      expect(created.zone).toEqual("us-central1-a");
      expect(created.machineType).toEqual("e2-micro");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.tags).toEqual(["alchemy-test"]);
      expect(created.metadata).toMatchObject({ role: "test" });

      const fetched = yield* compute.getInstances({
        project: created.project,
        zone: created.zone,
        instance: created.instanceName,
      });
      expect(fetched.name).toEqual(created.instanceName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.tags?.items).toEqual(["alchemy-test"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Instance("Vm", {
            instanceName: created.instanceName,
            zone: "us-central1-a",
            machineType: "e2-micro",
            labels: { env: "prod", role: "web" },
            tags: ["alchemy-prod"],
            metadata: { role: "prod" },
            associatePublicIp: false,
          });
        }),
      );

      expect(updated.instanceName).toEqual(created.instanceName);
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });
      expect(updated.tags).toEqual(["alchemy-prod"]);
      expect(updated.metadata).toMatchObject({ role: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.zone,
        created.instanceName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 240_000 },
);
