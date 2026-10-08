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

const waitUntilGone = (project: string, region: string, disk: string) =>
  compute.getRegionDisks({ project, region, disk }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a region disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionDisk("Data", {
            region: "us-central1",
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "pd-standard",
            sizeGb: 200,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.diskName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.replicaZones).toEqual(["us-central1-a", "us-central1-b"]);
      expect(created.type).toEqual("pd-standard");
      expect(created.sizeGb).toEqual(200);
      expect(created.status).toEqual("READY");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* compute.getRegionDisks({
        project: created.project,
        region: created.region,
        disk: created.diskName,
      });
      expect(fetched.name).toEqual(created.diskName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.sizeGb).toEqual("200");
      expect(fetched.region).toEqual(expect.stringContaining("us-central1"));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionDisk("Data", {
            diskName: created.diskName,
            region: "us-central1",
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "pd-standard",
            sizeGb: 201,
            labels: { env: "prod", role: "data" },
          });
        }),
      );

      expect(updated.diskName).toEqual(created.diskName);
      expect(updated.sizeGb).toEqual(201);
      expect(updated.labels).toMatchObject({ env: "prod", role: "data" });

      const fetchedUpdated = yield* compute.getRegionDisks({
        project: updated.project,
        region: updated.region,
        disk: updated.diskName,
      });
      expect(fetchedUpdated.sizeGb).toEqual("201");
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("data");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.diskName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
