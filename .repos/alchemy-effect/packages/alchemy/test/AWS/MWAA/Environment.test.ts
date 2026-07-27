import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as mwaa from "@distilled.cloud/aws/mwaa";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled mwaa error union carries the
// ResourceNotFoundException tag this provider's read/delete paths depend on. A
// well-formed but nonexistent environment name returns ResourceNotFoundException.
test.provider(
  "getEnvironment on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mwaa.getEnvironment({ Name: "alchemy-mwaa-nonexistent-probe" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Resolve two subnets from the account's default VPC in distinct Availability
// Zones plus the VPC's default security group. NOTE: a REAL MWAA environment
// requires PRIVATE subnets with outbound internet egress (NAT gateway or the
// full set of MWAA VPC interface endpoints). The factory never creates NAT
// gateways, so this networking is expected to be supplied out of band by an
// entitled/patient runner — which is exactly why the lifecycle below is gated.
const resolveNetwork = Effect.gen(function* () {
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const byAz = new Map<string, string>();
  for (const s of subnets.Subnets ?? []) {
    if (s.AvailabilityZone && s.SubnetId && !byAz.has(s.AvailabilityZone)) {
      byAz.set(s.AvailabilityZone, s.SubnetId);
    }
  }
  const subnetIds = [...byAz.values()].slice(0, 2);

  const sgs = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const securityGroupId = sgs.SecurityGroups?.[0]?.GroupId;
  return { subnetIds, securityGroupId };
});

// MWAA execution role: trusts the Airflow environment + task principals and
// grants the standard access to the DAGs bucket, CloudWatch Logs, SQS, and KMS.
const executionRolePolicy = (
  bucketArn: Output.Output<string>,
  region: string,
  account: string,
) => ({
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Action: ["airflow:PublishMetrics"],
      Resource: [`arn:aws:airflow:${region}:${account}:environment/*`],
    },
    {
      Effect: "Allow" as const,
      Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
      Resource: [bucketArn, Output.interpolate`${bucketArn}/*`],
    },
    {
      Effect: "Allow" as const,
      Action: [
        "logs:CreateLogStream",
        "logs:CreateLogGroup",
        "logs:PutLogEvents",
        "logs:GetLogEvents",
        "logs:GetLogRecord",
        "logs:GetLogGroupFields",
        "logs:GetQueryResults",
        "logs:DescribeLogGroups",
      ],
      Resource: [`arn:aws:logs:${region}:${account}:log-group:airflow-*`],
    },
    {
      Effect: "Allow" as const,
      Action: ["cloudwatch:PutMetricData"],
      Resource: ["*"],
    },
    {
      Effect: "Allow" as const,
      Action: [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ReceiveMessage",
        "sqs:SendMessage",
      ],
      Resource: [`arn:aws:sqs:${region}:*:airflow-celery-*`],
    },
  ],
});

// MWAA environments take ~20-30 minutes to create, ~20-30 minutes to delete,
// and are billed hourly while they exist. The full lifecycle is gated behind
// AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create environment, verify available, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId, region } = yield* AWSEnvironment.current;
      const { subnetIds, securityGroupId } = yield* resolveNetwork;
      expect(subnetIds.length).toBe(2);
      expect(securityGroupId).toBeDefined();

      const { environment } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("Dags", {
            versioning: "Enabled",
            forceDestroy: true,
          });
          const role = yield* AWS.IAM.Role("ExecutionRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: [
                      "airflow.amazonaws.com",
                      "airflow-env.amazonaws.com",
                    ],
                  },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              "mwaa-execution": executionRolePolicy(
                bucket.bucketArn,
                region,
                accountId,
              ),
            },
          });
          const environment = yield* AWS.MWAA.Environment("Airflow", {
            executionRoleArn: role.roleArn,
            sourceBucketArn: bucket.bucketArn,
            dagS3Path: "dags",
            subnetIds,
            securityGroupIds: securityGroupId ? [securityGroupId] : undefined,
            environmentClass: "mw1.small",
            maxWorkers: 2,
            minWorkers: 1,
            webserverAccessMode: "PUBLIC_ONLY",
            loggingConfiguration: {
              schedulerLogs: { enabled: true, logLevel: "INFO" },
              taskLogs: { enabled: true, logLevel: "INFO" },
            },
            tags: { fixture: "mwaa-environment" },
          });
          return { environment };
        }),
      );

      expect(environment.environmentName).toBeDefined();
      expect(environment.arn).toContain(":environment/");
      expect(environment.status).toBe("AVAILABLE");
      expect(environment.webserverUrl).toBeDefined();

      // Out-of-band verification via distilled.
      const described = yield* mwaa.getEnvironment({
        Name: environment.environmentName,
      });
      expect(described.Environment?.Status).toBe("AVAILABLE");
      expect(described.Environment?.EnvironmentClass).toBe("mw1.small");
      expect(described.Environment?.Tags?.fixture).toBe("mwaa-environment");

      yield* stack.destroy();
      yield* assertEnvironmentDeleted(environment.environmentName);
    }),
  // create (~20-30 min) + destroy initiation, one test.
  { timeout: 4_200_000 },
);

// Deletion is verified as INITIATED (status DELETING, irreversible) or fully
// gone. Full disappearance takes ~20-30 more minutes server-side.
const assertEnvironmentDeleted = (name: string) =>
  Effect.gen(function* () {
    const status = yield* mwaa.getEnvironment({ Name: name }).pipe(
      Effect.map((r) => r.Environment?.Status ?? "gone"),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone" && status !== "DELETING") {
      return yield* Effect.fail(
        new Error(
          `MWAA environment '${name}' still exists (status: ${status})`,
        ),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
