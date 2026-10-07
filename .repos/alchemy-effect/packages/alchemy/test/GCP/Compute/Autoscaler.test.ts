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

const zone = "us-central1-a";

const waitUntilGone = (autoscaler: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getAutoscalers({ project, zone, autoscaler }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status === "gone",
          times: 10,
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
  "create, update, replace, and delete an autoscaler",
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
          const mig = yield* GCP.Compute.InstanceGroupManager("Mig", {
            zone,
            instanceTemplate: template.templateName.as<string>(),
            targetSize: 0,
          });
          const scaler = yield* GCP.Compute.Autoscaler("Scale", {
            zone,
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
      expect(created.scaler.zone).toEqual(zone);
      expect(created.scaler.description).toEqual("test scaler");
      expect(created.scaler.labels).toMatchObject({ env: "test" });
      expect(created.scaler.autoscalingPolicy?.maxNumReplicas).toEqual(1);
      expect(created.scaler.autoscalingPolicy?.minNumReplicas).toEqual(0);
      expect(created.scaler.autoscalingPolicy?.mode).toEqual("OFF");

      const fetched = yield* compute.getAutoscalers({
        project,
        zone,
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

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate(
            "Tpl",
            templateProps,
          );
          const mig = yield* GCP.Compute.InstanceGroupManager("Mig", {
            zone,
            instanceTemplate: template.templateName.as<string>(),
            targetSize: 0,
          });
          const scaler = yield* GCP.Compute.Autoscaler("Scale", {
            autoscalerName: created.scaler.autoscalerName,
            zone,
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

      const refetched = yield* compute.getAutoscalers({
        project,
        zone,
        autoscaler: updated.scaler.autoscalerName,
      });
      expect(refetched.id).toEqual(created.scaler.autoscalerId);
      expect(refetched.description).toContain("updated scaler");
      expect(refetched.description).toContain("env=prod");
      expect(refetched.autoscalingPolicy?.maxNumReplicas).toEqual(2);
      expect(
        refetched.autoscalingPolicy?.cpuUtilization?.utilizationTarget,
      ).toEqual(0.5);

      const replacedName = `${created.scaler.autoscalerName.replace(/-+$/, "").slice(0, 61)}-r`;
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Compute.InstanceTemplate(
            "Tpl",
            templateProps,
          );
          const mig = yield* GCP.Compute.InstanceGroupManager("Mig", {
            zone,
            instanceTemplate: template.templateName.as<string>(),
            targetSize: 0,
          });
          const scaler = yield* GCP.Compute.Autoscaler("Scale", {
            autoscalerName: replacedName,
            zone,
            target: mig.selfLink.as<string>(),
            description: "replaced scaler",
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

      expect(replaced.scaler.autoscalerName).toEqual(replacedName);
      expect(replaced.scaler.description).toEqual("replaced scaler");
      expect(replaced.scaler.autoscalerId).not.toEqual(
        created.scaler.autoscalerId,
      );

      const replacedFetched = yield* compute.getAutoscalers({
        project,
        zone,
        autoscaler: replaced.scaler.autoscalerName,
      });
      expect(replacedFetched.name).toEqual(replacedName);
      expect(replacedFetched.description).toContain("replaced scaler");

      const oldGone = yield* waitUntilGone(created.scaler.autoscalerName);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.scaler.autoscalerName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
