import * as AWS from "@/AWS";
import { Domain, EnvironmentBlueprintConfiguration } from "@/AWS/DataZone";
import * as IAM from "@/AWS/IAM";
import * as Test from "@/Test/Alchemy";
import * as datazone from "@distilled.cloud/aws/datazone";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const findConfiguration = (domainId: string, blueprintId: string) =>
  datazone
    .getEnvironmentBlueprintConfiguration({
      domainIdentifier: domainId,
      environmentBlueprintIdentifier: blueprintId,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
      // once the domain is deleted, DataZone reports AccessDenied (auth is
      // checked before existence) — also "absent".
      Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
    );

test.provider(
  "enable the DefaultDataLake blueprint in a domain, then remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Deploy a domain, the provisioning/manage-access roles, and the
      //    blueprint configuration.
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* Domain("BlueprintTestDomain", {
            description: "alchemy datazone blueprint config test",
          });
          const provisioningRole = yield* IAM.Role("DataZoneProvisioningRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "cloudformation.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonDataZoneRedshiftGlueProvisioningPolicy",
            ],
          });
          const manageAccessRole = yield* IAM.Role("DataZoneManageAccessRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "datazone.amazonaws.com" },
                  Action: ["sts:AssumeRole", "sts:TagSession"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AmazonDataZoneGlueManageAccessRolePolicy",
            ],
          });
          const config = yield* EnvironmentBlueprintConfiguration(
            "DataLakeBlueprint",
            {
              domainId: domain.domainId,
              environmentBlueprint: "DefaultDataLake",
              enabledRegions: ["us-west-2"],
              provisioningRoleArn: provisioningRole.roleArn,
              manageAccessRoleArn: manageAccessRole.roleArn,
            },
          );
          return {
            domainId: domain.domainId,
            environmentBlueprintId: config.environmentBlueprintId,
            environmentBlueprintName: config.environmentBlueprintName,
            enabledRegions: config.enabledRegions,
            provisioningRoleArn: config.provisioningRoleArn,
            manageAccessRoleArn: config.manageAccessRoleArn,
          };
        }),
      );

      expect(result.environmentBlueprintName).toBe("DefaultDataLake");
      expect(result.environmentBlueprintId).toBeDefined();
      expect(result.enabledRegions).toEqual(["us-west-2"]);

      // out-of-band: the configuration exists with the requested roles.
      const created = yield* findConfiguration(
        result.domainId,
        result.environmentBlueprintId,
      );
      expect(created).toBeDefined();
      expect(created!.enabledRegions).toEqual(["us-west-2"]);
      expect(created!.provisioningRoleArn).toBe(result.provisioningRoleArn);
      expect(created!.manageAccessRoleArn).toBe(result.manageAccessRoleArn);

      // 2. Update — the PUT converges regional parameters in place.
      yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* Domain("BlueprintTestDomain", {
            description: "alchemy datazone blueprint config test",
          });
          const provisioningRole = yield* IAM.Role("DataZoneProvisioningRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "cloudformation.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AmazonDataZoneRedshiftGlueProvisioningPolicy",
            ],
          });
          const manageAccessRole = yield* IAM.Role("DataZoneManageAccessRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "datazone.amazonaws.com" },
                  Action: ["sts:AssumeRole", "sts:TagSession"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AmazonDataZoneGlueManageAccessRolePolicy",
            ],
          });
          yield* EnvironmentBlueprintConfiguration("DataLakeBlueprint", {
            domainId: domain.domainId,
            environmentBlueprint: "DefaultDataLake",
            enabledRegions: ["us-west-2"],
            provisioningRoleArn: provisioningRole.roleArn,
            manageAccessRoleArn: manageAccessRole.roleArn,
            regionalParameters: {
              "us-west-2": { S3Location: "s3://alchemy-datazone-test" },
            },
          });
        }),
      );

      const updated = yield* findConfiguration(
        result.domainId,
        result.environmentBlueprintId,
      );
      expect(updated!.regionalParameters?.["us-west-2"]?.S3Location).toBe(
        "s3://alchemy-datazone-test",
      );

      // 3. Destroy — the configuration is deleted (before its domain). The
      //    domain delete waits until the domain is gone, so the config
      //    lookup must observe "absent" immediately after destroy.
      yield* stack.destroy();
      const gone = yield* findConfiguration(
        result.domainId,
        result.environmentBlueprintId,
      );
      expect(gone).toBeUndefined();
    }),
  { timeout: 480_000 },
);
