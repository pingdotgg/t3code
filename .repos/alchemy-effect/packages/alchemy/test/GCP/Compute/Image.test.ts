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

const waitUntilGone = (project: string, image: string) =>
  compute.getImages({ project, image }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 18,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.Disk("Data", {
            zone: "us-central1-a",
            type: "pd-standard",
            sizeGb: 10,
          });
          const image = yield* GCP.Compute.Image("Boot", {
            sourceDisk: disk.selfLink.as<string>(),
            family: "alchemy-test",
            description: "alchemy test image",
            labels: { env: "test" },
            storageLocations: ["us-central1"],
          });
          return { disk, image };
        }),
      );

      expect(created.image.imageName).toEqual(expect.any(String));
      expect(created.image.status).toEqual("READY");
      expect(created.image.family).toEqual("alchemy-test");
      expect(created.image.description).toEqual("alchemy test image");
      expect(created.image.labels).toMatchObject({ env: "test" });
      expect(created.image.project).toEqual(expect.any(String));
      expect(created.image.selfLink).toEqual(expect.any(String));

      const fetched = yield* compute.getImages({
        project: created.image.project,
        image: created.image.imageName,
      });
      expect(fetched.name).toEqual(created.image.imageName);
      expect(fetched.status).toEqual("READY");
      expect(fetched.family).toEqual("alchemy-test");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.Disk("Data", {
            diskName: created.disk.diskName,
            zone: "us-central1-a",
            type: "pd-standard",
            sizeGb: 10,
          });
          const image = yield* GCP.Compute.Image("Boot", {
            imageName: created.image.imageName,
            sourceDisk: disk.selfLink.as<string>(),
            family: "alchemy-prod",
            description: "updated alchemy test image",
            labels: { env: "prod", role: "boot" },
            storageLocations: ["us-central1"],
          });
          return { disk, image };
        }),
      );

      expect(updated.image.imageName).toEqual(created.image.imageName);
      expect(updated.image.family).toEqual("alchemy-prod");
      expect(updated.image.description).toEqual("updated alchemy test image");
      expect(updated.image.labels).toMatchObject({ env: "prod", role: "boot" });

      const refetched = yield* compute.getImages({
        project: updated.image.project,
        image: updated.image.imageName,
      });
      expect(refetched.family).toEqual("alchemy-prod");
      expect(refetched.description).toEqual("updated alchemy test image");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("boot");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.image.project,
        created.image.imageName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 240_000 },
);
