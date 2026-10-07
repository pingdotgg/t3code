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

const waitUntilGone = (autoscaler: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getRegionAutoscalers({ project, region, autoscaler }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 15,
        }),
      ),
    ),
  );

const templateProps: GCP.Compute.InstanceTemplateProps = {
  machineType: "e2-micro",
  disks: [
    {
      boot: true,
      autoDelete: true,
      sourceImage: "projects/debian-cloud/global/images/family/debian-12",
      diskSizeGb: 10,
    },
  ],
  networkInterfaces: [{ network: "global/networks/default" }],
};

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a region autoscaler",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate(
            "Tpl",
            templateProps,
          );
          const mig = yield* GCP.Compute.RegionInstanceGroupManager("Mig", {
            region,
            instanceTemplate: template.templateName.as<string>(),
            targetSize: 0,
          });
          const scaler = yield* GCP.Compute.RegionAutoscaler("Scale", {
            region,
            target: mig.selfLink.as<string>(),
            description: "test scaler",
            labels: { env: "test" },
            autoscalingPolicy: {
              minNumReplicas: 0,
              maxNumReplicas: 1,
              coolDownPeriodSec: 60,
              mode: "OFF",
              cpuUtilization: { utilizationTarget: 0.6 },
            },
          });
          return { template, mig, scaler };
        }),
      );

      expect(created.scaler.autoscalerName).toEqual(expect.any(String));
      expect(created.scaler.region).toEqual(region);
      expect(created.scaler.project).toEqual(project);
      expect(created.scaler.description).toEqual("test scaler");
      expect(created.scaler.labels).toMatchObject({ env: "test" });
      expect(created.scaler.target).toContain(created.mig.managerName);
      expect(created.scaler.autoscalingPolicy?.maxNumReplicas).toEqual(1);
      expect(created.scaler.autoscalingPolicy?.minNumReplicas).toEqual(0);
      expect(created.scaler.autoscalingPolicy?.mode).toEqual("OFF");

      const fetched = yield* compute.getRegionAutoscalers({
        project,
        region,
        autoscaler: created.scaler.autoscalerName,
      });
      expect(fetched.name).toEqual(created.scaler.autoscalerName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("test scaler");
      expect(fetched.description).toContain("env=test");
      expect(fetched.autoscalingPolicy?.maxNumReplicas).toEqual(1);
      expect(fetched.autoscalingPolicy?.coolDownPeriodSec).toEqual(60);
      expect(
        fetched.autoscalingPolicy?.cpuUtilization?.utilizationTarget,
      ).toEqual(0.6);
      expect(fetched.target).toEqual(expect.any(String));
      expect(fetched.target).toContain(created.mig.managerName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate(
            "Tpl",
            templateProps,
          );
          const mig = yield* GCP.Compute.RegionInstanceGroupManager("Mig", {
            region,
            instanceTemplate: template.templateName.as<string>(),
            targetSize: 0,
          });
          const scaler = yield* GCP.Compute.RegionAutoscaler("Scale", {
            region,
            target: mig.selfLink.as<string>(),
            description: "updated scaler",
            labels: { env: "prod", role: "scale" },
            autoscalingPolicy: {
              minNumReplicas: 0,
              maxNumReplicas: 2,
              coolDownPeriodSec: 90,
              mode: "OFF",
              cpuUtilization: { utilizationTarget: 0.5 },
            },
          });
          return { template, mig, scaler };
        }),
      );

      expect(updated.scaler.autoscalerName).toEqual(
        created.scaler.autoscalerName,
      );
      expect(updated.scaler.autoscalerId).toEqual(created.scaler.autoscalerId);
      expect(updated.scaler.description).toEqual("updated scaler");
      expect(updated.scaler.labels).toMatchObject({
        env: "prod",
        role: "scale",
      });
      expect(updated.scaler.autoscalingPolicy?.maxNumReplicas).toEqual(2);
      expect(updated.scaler.autoscalingPolicy?.coolDownPeriodSec).toEqual(90);

      const refetched = yield* compute.getRegionAutoscalers({
        project,
        region,
        autoscaler: updated.scaler.autoscalerName,
      });
      expect(refetched.id).toEqual(created.scaler.autoscalerId);
      expect(refetched.description).toContain("updated scaler");
      expect(refetched.description).toContain("env=prod");
      expect(refetched.autoscalingPolicy?.maxNumReplicas).toEqual(2);
      expect(
        refetched.autoscalingPolicy?.cpuUtilization?.utilizationTarget,
      ).toEqual(0.5);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.scaler.autoscalerName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
