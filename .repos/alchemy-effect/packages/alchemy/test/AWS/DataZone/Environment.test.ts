import * as AWS from "@/AWS";
import {
  Domain,
  Environment,
  EnvironmentBlueprintConfiguration,
  Project,
} from "@/AWS/DataZone";
import * as IAM from "@/AWS/IAM";
import * as S3 from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as datazone from "@distilled.cloud/aws/datazone";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

// Environment deployment drives a CloudFormation stack (several minutes each
// way) — the full lifecycle only runs when explicitly requested.
const RUN_SLOW = process.env.AWS_TEST_SLOW === "1";

// The DefaultDataLake blueprint requires an S3 location whose bucket name
// contains "datazone" (the provisioning policy scopes S3 access to
// *datazone* buckets). Deterministic constant — never Date.now().
const DATALAKE_BUCKET = "amazon-datazone-391965393224-usw2-alchemy-test";

// Ungated: the typed error union covers the not-found probe — proves the
// distilled error mapping without provisioning anything.
test.provider("getEnvironment on a nonexistent domain is typed", () =>
  Effect.gen(function* () {
    const result = yield* datazone
      .getEnvironment({
        domainIdentifier: "dzd_000000000000",
        identifier: "0000000000",
      })
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect([
        "ResourceNotFoundException",
        "AccessDeniedException",
        "ValidationException",
      ]).toContain(result.failure._tag);
    }
  }),
);

/** Domain + roles + bucket + blueprint config + project shared by both deploys. */
const baseInfra = Effect.gen(function* () {
  const domain = yield* Domain("EnvTestDomain", {
    description: "alchemy datazone environment test",
  });
  const provisioningRole = yield* IAM.Role("EnvProvisioningRole", {
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
  const manageAccessRole = yield* IAM.Role("EnvManageAccessRole", {
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
  const bucket = yield* S3.Bucket("EnvDataLakeBucket", {
    bucketName: DATALAKE_BUCKET,
    forceDestroy: true,
  });
  const config = yield* EnvironmentBlueprintConfiguration(
    "EnvDataLakeBlueprint",
    {
      domainId: domain.domainId,
      environmentBlueprint: "DefaultDataLake",
      enabledRegions: ["us-west-2"],
      provisioningRoleArn: provisioningRole.roleArn,
      manageAccessRoleArn: manageAccessRole.roleArn,
      regionalParameters: {
        "us-west-2": { S3Location: `s3://${DATALAKE_BUCKET}` },
      },
    },
  );
  const project = yield* Project("EnvTestProject", {
    domainId: domain.domainId,
    description: "environment test project",
  });
  return { domain, config, project };
});

test.provider.skipIf(!RUN_SLOW)(
  "create environment from the DefaultDataLake blueprint, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Deploy the domain, project, roles, bucket, and blueprint config.
      const base = yield* stack.deploy(
        Effect.gen(function* () {
          const { domain, config, project } = yield* baseInfra;
          return {
            domainId: domain.domainId,
            projectId: project.projectId,
            environmentBlueprintId: config.environmentBlueprintId,
          };
        }),
      );

      // 2. Create an environment profile out-of-band (no alchemy resource
      //    for it yet) and deploy the Environment from it.
      const profile = yield* datazone.createEnvironmentProfile({
        domainIdentifier: base.domainId,
        name: "alchemy-env-test-profile",
        environmentBlueprintIdentifier: base.environmentBlueprintId,
        projectIdentifier: base.projectId,
        awsAccountId: "391965393224",
        awsAccountRegion: "us-west-2",
      });

      const result = yield* stack
        .deploy(
          Effect.gen(function* () {
            const { domain, project } = yield* baseInfra;
            const env = yield* Environment("TestEnvironment", {
              domainId: domain.domainId,
              projectId: project.projectId,
              environmentProfileId: profile.id,
              description: "alchemy environment",
            });
            return {
              environmentId: env.environmentId,
              status: env.status,
            };
          }),
        )
        .pipe(
          Effect.ensuring(
            // the environment profile blocks domain deletion — always remove
            // it before the final destroy, even when the deploy fails.
            datazone
              .deleteEnvironmentProfile({
                domainIdentifier: base.domainId,
                identifier: profile.id,
              })
              .pipe(Effect.ignore),
          ),
        );

      expect(result.environmentId).toBeDefined();
      expect(result.status).toBe("ACTIVE");

      // out-of-band: the environment is ACTIVE.
      const created = yield* datazone.getEnvironment({
        domainIdentifier: base.domainId,
        identifier: result.environmentId,
      });
      expect(created.status).toBe("ACTIVE");
      expect(created.projectId).toBe(base.projectId);

      // 3. Destroy — environment, project, blueprint config, and domain.
      yield* stack.destroy();
      const gone = yield* datazone
        .getEnvironment({
          domainIdentifier: base.domainId,
          identifier: result.environmentId,
        })
        .pipe(
          Effect.map((env) => env.status === "DELETED"),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
          // once the domain is deleted, DataZone reports AccessDenied (auth
          // is checked before existence) — also gone.
          Effect.catchTag("AccessDeniedException", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 1_100_000 },
);
