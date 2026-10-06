import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as clouddeploy from "@distilled.cloud/gcp/clouddeploy_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  clouddeploy.getProjectsLocationsDeliveryPipelinesAutomations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDeliveryPipelinesAutomations on a missing automation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        clouddeploy.getProjectsLocationsDeliveryPipelinesAutomations({
          name: `projects/${project}/locations/us-central1/deliveryPipelines/alchemy-missing-pipeline/automations/alchemy-missing-automation`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:clouddeploy", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a delivery pipeline automation",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const serviceAccount =
        process.env.GCP_TEST_CLOUDDEPLOY_SA ??
        `alchemy-testing@${project}.iam.gserviceaccount.com`;
      const runLocation = `projects/${project}/locations/us-central1`;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* GCP.CloudDeploy.Target("Staging", {
            run: { location: runLocation },
            labels: { env: "test" },
          });
          const pipeline = yield* GCP.CloudDeploy.DeliveryPipeline("App", {
            serialPipeline: { stages: [{ targetId: target.targetId }] },
            description: "alchemy-test-automation-pipeline",
            labels: { env: "test" },
          });
          const automation = yield* GCP.CloudDeploy.DeliveryPipelinesAutomation(
            "Promote",
            {
              deliveryPipeline: pipeline.name,
              serviceAccount,
              selector: { targets: [{ id: "*" }] },
              rules: [{ promoteReleaseRule: { id: "promote-release" } }],
              description: "alchemy-test-automation",
              labels: { env: "test" },
            },
          );
          return { target, pipeline, automation };
        }),
      );

      expect(created.automation.name).toContain("/automations/");
      expect(created.automation.automationId).toEqual(expect.any(String));
      expect(created.automation.deliveryPipeline).toEqual(
        created.pipeline.name,
      );
      expect(created.automation.location).toEqual("us-central1");
      expect(created.automation.description).toEqual("alchemy-test-automation");
      expect(created.automation.serviceAccount).toEqual(serviceAccount);
      expect(created.automation.selector?.targets?.[0]?.id).toEqual("*");
      expect(created.automation.rules[0]?.promoteReleaseRule?.id).toEqual(
        "promote-release",
      );
      expect(created.automation.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* clouddeploy.getProjectsLocationsDeliveryPipelinesAutomations({
          name: created.automation.name,
        });
      expect(fetched.name).toEqual(created.automation.name);
      expect(fetched.description).toEqual("alchemy-test-automation");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* GCP.CloudDeploy.Target("Staging", {
            targetId: created.target.targetId,
            run: { location: runLocation },
            labels: { env: "test" },
          });
          const pipeline = yield* GCP.CloudDeploy.DeliveryPipeline("App", {
            deliveryPipelineId: created.pipeline.deliveryPipelineId,
            serialPipeline: { stages: [{ targetId: target.targetId }] },
            description: "alchemy-test-automation-pipeline",
            labels: { env: "test" },
          });
          const automation = yield* GCP.CloudDeploy.DeliveryPipelinesAutomation(
            "Promote",
            {
              automationId: created.automation.automationId,
              deliveryPipeline: pipeline.name,
              serviceAccount,
              selector: { targets: [{ id: "*" }] },
              rules: [{ promoteReleaseRule: { id: "promote-release" } }],
              description: "alchemy-prod-automation",
              labels: { env: "prod", role: "promote" },
            },
          );
          return automation;
        }),
      );

      expect(updated.name).toEqual(created.automation.name);
      expect(updated.description).toEqual("alchemy-prod-automation");
      expect(updated.labels).toMatchObject({ env: "prod", role: "promote" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.automation.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:clouddeploy", "live"],
    timeout: 120_000,
  },
);
