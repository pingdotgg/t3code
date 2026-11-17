import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as mwaa from "@distilled.cloud/aws/mwaa";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { MwaaNetwork } from "./network.ts";

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
  { tags: ["provider:aws", "provider:aws:mwaa", "live"] },
);

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

// MWAA environments take ~20-30 minutes to create and ~20-30 minutes to
// delete (the provider waits for deletion so the in-stack VPC can be torn
// down), and are billed hourly (~$0.49/h for mw1.small, plus ~$0.045/h for the
// test's single NAT gateway). The test builds its own private networking
// (VPC + 2 private subnets in 2 AZs + IGW + one NAT gateway, see network.ts),
// so the only reason for skipping it under `--fast` is time and cost.
test.provider.skipIf(!!process.env.FAST)(
  "create environment, verify available, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId, region } = yield* AWSEnvironment.current;

      const { environment } = yield* stack.deploy(
        Effect.gen(function* () {
          const { subnetIds, securityGroupIds } = yield* MwaaNetwork("MwaaNetwork", "10.86.0.0/16");
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
                    Service: ["airflow.amazonaws.com", "airflow-env.amazonaws.com"],
                  },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              "mwaa-execution": executionRolePolicy(bucket.bucketArn, region, accountId),
            },
          });
          const environment = yield* AWS.MWAA.Environment("Airflow", {
            executionRoleArn: role.roleArn,
            sourceBucketArn: bucket.bucketArn,
            dagS3Path: "dags",
            subnetIds,
            securityGroupIds,
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
      // MWAA leaves its per-module log groups behind; the delete reaps them.
      const { logGroups } = yield* logs.describeLogGroups({
        logGroupNamePrefix: `airflow-${environment.environmentName}-`,
      });
      expect(logGroups ?? []).toEqual([]);
      // Billable NAT gateway + environment: never leave them behind on failure.
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  // network + create (~20-30 min) + delete-until-gone (~20-30 min) + network teardown.
  {
    tags: [
      "provider:aws",
      "provider:aws:ec2",
      "provider:aws:iam",
      "provider:aws:mwaa",
      "provider:aws:s3",
      "live",
    ],
    timeout: 6_000_000,
  },
);

// The provider's delete waits until the environment is gone; tolerate a
// lingering DELETING status for eventual consistency of GetEnvironment.
const assertEnvironmentDeleted = (name: string) =>
  Effect.gen(function* () {
    const status = yield* mwaa.getEnvironment({ Name: name }).pipe(
      Effect.map((r) => r.Environment?.Status ?? "gone"),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed("gone" as const)),
    );
    if (status !== "gone" && status !== "DELETING") {
      return yield* Effect.fail(
        new Error(`MWAA environment '${name}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(20)]),
    }),
  );
