import * as AWS from "@/AWS";
import { Application } from "@/AWS/CodeDeploy/Application.ts";
import { DeploymentConfig } from "@/AWS/CodeDeploy/DeploymentConfig.ts";
import { DeploymentGroup } from "@/AWS/CodeDeploy/DeploymentGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const applicationName = "alchemy-test-cd-app";
const deploymentGroupName = "alchemy-test-cd-dg";
const deploymentConfigName = "alchemy-test-cd-config";

const getGroup = codedeploy
  .getDeploymentGroup({ applicationName, deploymentGroupName })
  .pipe(
    Effect.map((res) => res.deploymentGroupInfo),
    Effect.catchTag(
      [
        "DeploymentGroupDoesNotExistException",
        "ApplicationDoesNotExistException",
      ],
      () => Effect.succeed(undefined),
    ),
  );

// A Lambda-platform deployment group: an application, a custom canary
// deployment configuration, a CodeDeploy service role (assumed by
// codedeploy.amazonaws.com, granted the AWS-managed Lambda policy), and the
// group tying a deployment config to the application.
const makeStack = (useCustomConfig: boolean) =>
  Effect.gen(function* () {
    const app = yield* Application("App", {
      applicationName,
      computePlatform: "Lambda",
    });
    const config = yield* DeploymentConfig("Config", {
      deploymentConfigName,
      computePlatform: "Lambda",
      trafficRoutingConfig: {
        type: "TimeBasedCanary",
        timeBasedCanary: { canaryPercentage: 10, canaryInterval: 1 },
      },
    });
    const role = yield* AWS.IAM.Role("DeployRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "codedeploy.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda",
      ],
    });
    const group = yield* DeploymentGroup("Group", {
      applicationName: app.applicationName,
      deploymentGroupName,
      serviceRoleArn: role.roleArn,
      deploymentConfigName: useCustomConfig
        ? config.deploymentConfigName
        : "CodeDeployDefault.LambdaAllAtOnce",
      deploymentStyle: {
        deploymentType: "BLUE_GREEN",
        deploymentOption: "WITH_TRAFFIC_CONTROL",
      },
      autoRollbackConfiguration: {
        enabled: true,
        events: ["DEPLOYMENT_FAILURE"],
      },
      tags: { env: "test" },
    });
    return { app, config, group };
  });

test.provider(
  "lifecycle: create Lambda application + deployment group, update config, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(makeStack(false));
      expect(deployed.app.applicationName).toBe(applicationName);
      expect(deployed.app.applicationArn).toContain(":application:");
      expect(deployed.app.computePlatform).toBe("Lambda");
      expect(deployed.group.deploymentGroupName).toBe(deploymentGroupName);
      expect(deployed.group.deploymentGroupArn).toContain(":deploymentgroup:");
      expect(deployed.config.deploymentConfigName).toBe(deploymentConfigName);
      expect(deployed.config.deploymentConfigArn).toContain(
        ":deploymentconfig:",
      );
      expect(deployed.config.deploymentConfigId).toBeTruthy();
      expect(deployed.config.computePlatform).toBe("Lambda");

      // Out-of-band verification via distilled.
      const created = yield* getGroup;
      expect(created?.deploymentGroupName).toBe(deploymentGroupName);
      expect(created?.computePlatform).toBe("Lambda");
      expect(created?.deploymentConfigName).toBe(
        "CodeDeployDefault.LambdaAllAtOnce",
      );

      const appCheck = yield* codedeploy.getApplication({ applicationName });
      expect(appCheck.application?.computePlatform).toBe("Lambda");

      // Out-of-band verification of the custom deployment configuration.
      const configCheck = yield* codedeploy.getDeploymentConfig({
        deploymentConfigName,
      });
      expect(configCheck.deploymentConfigInfo?.computePlatform).toBe("Lambda");
      expect(
        configCheck.deploymentConfigInfo?.trafficRoutingConfig?.timeBasedCanary
          ?.canaryPercentage,
      ).toBe(10);

      // Canonical list() coverage for Application.
      const appProvider = yield* Provider.findProvider(Application);
      const apps = yield* appProvider.list();
      expect(apps.some((a) => a.applicationName === applicationName)).toBe(
        true,
      );

      // Canonical list() coverage for DeploymentConfig — custom configs are
      // listed, AWS-managed CodeDeployDefault.* ones are filtered out.
      const configProvider = yield* Provider.findProvider(DeploymentConfig);
      const configs = yield* configProvider.list();
      expect(
        configs.some((c) => c.deploymentConfigName === deploymentConfigName),
      ).toBe(true);
      expect(
        configs.every(
          (c) => !c.deploymentConfigName.startsWith("CodeDeployDefault."),
        ),
      ).toBe(true);

      // Update — point the group at the custom config in place (no
      // replacement).
      yield* stack.deploy(makeStack(true));
      const updated = yield* getGroup;
      expect(updated?.deploymentConfigName).toBe(deploymentConfigName);

      // Destroy — verify the group, application, and config are gone
      // out-of-band.
      yield* stack.destroy();
      const afterGroup = yield* getGroup;
      expect(afterGroup).toBeUndefined();
      const afterApp = yield* codedeploy
        .getApplication({ applicationName })
        .pipe(
          Effect.map((res) => res.application),
          Effect.catchTag("ApplicationDoesNotExistException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterApp).toBeUndefined();
      const afterConfig = yield* codedeploy
        .getDeploymentConfig({ deploymentConfigName })
        .pipe(
          Effect.map((res) => res.deploymentConfigInfo),
          Effect.catchTag("DeploymentConfigDoesNotExistException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(afterConfig).toBeUndefined();
    }),
  { timeout: 300_000 },
);
