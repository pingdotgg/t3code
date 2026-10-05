import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const region = "us-central1";

const waitUntilGone = (
  projectId: string,
  regionName: string,
  templateName: string,
) =>
  compute
    .getRegionInstanceTemplates({
      project: projectId,
      region: regionName,
      instanceTemplate: templateName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, replace, and delete a regional instance template",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionInstanceTemplate("Web", {
            region,
            machineType: "e2-micro",
            labels: { env: "test" },
            disks: [
              {
                boot: true,
                autoDelete: true,
                sourceImage:
                  "projects/debian-cloud/global/images/family/debian-12",
                diskSizeGb: 10,
              },
            ],
            networkInterfaces: [{ network: "global/networks/default" }],
          });
        }),
      );

      expect(created.templateName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.machineType).toEqual("e2-micro");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.project).toEqual(project);

      const fetched = yield* compute.getRegionInstanceTemplates({
        project,
        region,
        instanceTemplate: created.templateName,
      });
      expect(fetched.name).toEqual(created.templateName);
      expect(fetched.properties?.machineType).toEqual("e2-micro");
      expect(fetched.properties?.labels?.env).toEqual("test");
      expect(fetched.properties?.labels?.["alchemy-id"]).toEqual(
        expect.any(String),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionInstanceTemplate("Web", {
            templateName: created.templateName,
            region,
            machineType: "e2-small",
            labels: { env: "prod", role: "web" },
            disks: [
              {
                boot: true,
                autoDelete: true,
                sourceImage:
                  "projects/debian-cloud/global/images/family/debian-12",
                diskSizeGb: 10,
              },
            ],
            networkInterfaces: [{ network: "global/networks/default" }],
          });
        }),
      );

      expect(updated.templateName).toEqual(created.templateName);
      expect(updated.machineType).toEqual("e2-small");
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });

      const refetched = yield* compute.getRegionInstanceTemplates({
        project,
        region,
        instanceTemplate: updated.templateName,
      });
      expect(refetched.properties?.machineType).toEqual("e2-small");
      expect(refetched.properties?.labels?.env).toEqual("prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(project, region, created.templateName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
