import * as AWS from "@/AWS";
import { ComponentVersion, Deployment } from "@/AWS/GreengrassV2";
import { Thing } from "@/AWS/IoT";
import * as Test from "@/Test/Alchemy";
import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag the delete path depends on (deploymentId is a UUID, so a
// random-looking constant is safely nonexistent).
test.provider(
  "getDeployment on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        greengrassv2.getDeployment({
          deploymentId: "00000000-dead-beef-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const COMPONENT_NAME = "com.alchemy.test.GgDeploy";

const recipe = JSON.stringify({
  RecipeFormatVersion: "2020-01-25",
  ComponentName: COMPONENT_NAME,
  ComponentVersion: "1.0.0",
  ComponentDescription: "Alchemy GreengrassV2 deployment test component",
  ComponentPublisher: "Alchemy",
  Manifests: [
    {
      Platform: { os: "linux" },
      Lifecycle: { run: "echo deployed by alchemy" },
    },
  ],
});

const deploymentExists = (deploymentId: string) =>
  greengrassv2.getDeployment({ deploymentId }).pipe(
    Effect.map(() => true),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
  );

const waitUntilDeploymentGone = (deploymentId: string) =>
  deploymentExists(deploymentId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (exists) => exists === false,
      times: 10,
    }),
    Effect.map((exists) => expect(exists).toBe(false)),
  );

// A deployment targets an IoT thing (no live core device required — the
// deployment revision is created in the cloud and stays ACTIVE).
test.provider(
  "create deployment for a thing, revise components, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (merge?: string) =>
        Effect.gen(function* () {
          const core = yield* Thing("GgCore", {});
          const component = yield* ComponentVersion("DeployHello", {
            recipe,
          });
          const deployment = yield* Deployment("Rollout", {
            targetArn: core.thingArn,
            components: {
              [COMPONENT_NAME]: {
                // Output-valued reference makes the deployment depend on the
                // component version being registered first.
                componentVersion: component.componentVersion,
                ...(merge === undefined
                  ? {}
                  : { configurationUpdate: { merge } }),
              },
            },
            tags: { fixture: "greengrass-deployment" },
          });
          return { core, component, deployment };
        });

      // 1. CREATE.
      const { core, deployment } = yield* stack.deploy(program());
      expect(deployment.deploymentId).toBeDefined();
      expect(deployment.targetArn).toBe(core.thingArn);
      expect(deployment.deploymentArn).toContain(
        `:deployments:${deployment.deploymentId}`,
      );

      // Out-of-band verification via distilled.
      const observed = yield* greengrassv2.getDeployment({
        deploymentId: deployment.deploymentId,
      });
      expect(observed.targetArn).toBe(core.thingArn);
      expect(observed.isLatestForTarget).toBe(true);
      expect(observed.components?.[COMPONENT_NAME]?.componentVersion).toBe(
        "1.0.0",
      );
      expect(observed.tags?.["alchemy::id"]).toBe("Rollout");

      // 2. UPDATE — changing the component spec creates a NEW deployment
      //    revision (fresh deploymentId) and deletes the superseded one.
      const { deployment: revised } = yield* stack.deploy(
        program(JSON.stringify({ interval: 30 })),
      );
      expect(revised.deploymentId).not.toBe(deployment.deploymentId);
      const revisedObserved = yield* greengrassv2.getDeployment({
        deploymentId: revised.deploymentId,
      });
      expect(
        revisedObserved.components?.[COMPONENT_NAME]?.configurationUpdate
          ?.merge,
      ).toBe(JSON.stringify({ interval: 30 }));
      yield* waitUntilDeploymentGone(deployment.deploymentId);

      // 3. NO-OP — re-deploying the same spec keeps the same revision.
      const { deployment: stable } = yield* stack.deploy(
        program(JSON.stringify({ interval: 30 })),
      );
      expect(stable.deploymentId).toBe(revised.deploymentId);

      // 4. DESTROY — the deployment is canceled and deleted.
      yield* stack.destroy();
      yield* waitUntilDeploymentGone(revised.deploymentId);
    }),
  { timeout: 300_000 },
);
