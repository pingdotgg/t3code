import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  bigtable.getProjectsInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstances on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstances({
          name: `projects/${project}/instances/alchemy-bt-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* bigtable.listProjectsInstances({
        parent: `projects/${project}`,
      });
      expect((page.instances ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/instances/alchemy-bt-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt",
            type: "PRODUCTION",
            labels: { env: "test" },
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
        }),
      );

      expect(created.name).toContain("/instances/");
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.instanceId.length).toBeGreaterThanOrEqual(6);
      expect(created.displayName).toEqual("alchemy-test-bt");
      expect(created.type).toEqual("PRODUCTION");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("READY");

      const fetched = yield* bigtable.getProjectsInstances({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("alchemy-test-bt");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instanceId,
            displayName: "alchemy-prod-bt",
            type: "PRODUCTION",
            labels: { env: "prod", role: "bt" },
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-bt");
      expect(updated.labels).toMatchObject({ env: "prod", role: "bt" });

      const refetched = yield* bigtable.getProjectsInstances({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-bt");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("bt");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 120_000 },
);
