import * as AWS from "@/AWS";
import * as Output from "@/Output";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { getDefaultVpc } from "../DefaultVpc.ts";

export class MWAATestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "MWAATestFunction",
) {}

/**
 * Resolve two default-for-AZ subnets (distinct AZs) plus the default security
 * group from the account's default VPC. Runtime-guarded: the Lambda runtime
 * re-executes this props effect on cold start with no ec2:Describe*
 * permission, so return empty values there (network config is deploy-time
 * only). NOTE: a REAL MWAA environment requires PRIVATE subnets with outbound
 * egress — an entitled/patient runner supplies that out of band, which is why
 * the fixture is only deployed behind the AWS_TEST_SLOW gate.
 */
const resolveNetwork = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) {
    return { subnetIds: [] as string[], securityGroupIds: [] as string[] };
  }
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
  const sgs = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const securityGroupId = sgs.SecurityGroups?.[0]?.GroupId;
  return {
    subnetIds: [...byAz.values()].slice(0, 2),
    securityGroupIds: securityGroupId ? [securityGroupId] : [],
  };
}).pipe(
  // Deploy-time lookup only; a failure here is a fixture defect, not a typed
  // error the Function impl contract can carry.
  Effect.orDie,
);

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts on concrete fields
 * (or a typed tag), which proves the binding wiring, the environment-name
 * injection, and the IAM grants (environment-ARN-scoped for
 * CliToken/GetEnvironment, Airflow-role-ARN-scoped for WebLoginToken and
 * InvokeRestApi). An untyped error crashes into a 500.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

/**
 * Environment-scoped binding fixture: deploys a real MWAA environment
 * (~20-30 minutes to provision, billed hourly while it exists — gated behind
 * AWS_TEST_SLOW) plus its supporting cast (versioned DAGs bucket, execution
 * role) and a Lambda bound to all four MWAA bindings.
 */
export default MWAATestFunction.make(
  { main: import.meta.url, url: true },
  Effect.gen(function* () {
    const { subnetIds, securityGroupIds } = yield* resolveNetwork;

    const bucket = yield* AWS.S3.Bucket("MWAABindingsDags", {
      versioning: "Enabled",
      forceDestroy: true,
    });

    // The execution role Amazon MWAA and Airflow assume. Fixture-only wide
    // grants; the interesting IAM (the scoped airflow:* statements) is what
    // the bindings attach to the Lambda itself.
    const role = yield* AWS.IAM.Role("MWAABindingsExecutionRole", {
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
        "mwaa-execution": {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["airflow:PublishMetrics"],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
              Resource: [
                bucket.bucketArn,
                Output.interpolate`${bucket.bucketArn}/*`,
              ],
            },
            {
              Effect: "Allow",
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
              Resource: ["arn:aws:logs:*:*:log-group:airflow-*"],
            },
            {
              Effect: "Allow",
              Action: ["cloudwatch:PutMetricData"],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: [
                "sqs:ChangeMessageVisibility",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
                "sqs:GetQueueUrl",
                "sqs:ReceiveMessage",
                "sqs:SendMessage",
              ],
              Resource: ["arn:aws:sqs:*:*:airflow-celery-*"],
            },
          ],
        },
      },
    });

    const environment = yield* AWS.MWAA.Environment("BindingsAirflow", {
      executionRoleArn: role.roleArn,
      sourceBucketArn: bucket.bucketArn,
      dagS3Path: "dags",
      subnetIds,
      securityGroupIds:
        securityGroupIds.length > 0 ? securityGroupIds : undefined,
      environmentClass: "mw1.small",
      maxWorkers: 2,
      minWorkers: 1,
      webserverAccessMode: "PUBLIC_ONLY",
      tags: { fixture: "mwaa-bindings" },
    });

    const getEnvironment = yield* AWS.MWAA.GetEnvironment(environment);
    const createCliToken = yield* AWS.MWAA.CreateCliToken(environment);
    const createWebLoginToken =
      yield* AWS.MWAA.CreateWebLoginToken(environment);
    const invokeRestApi = yield* AWS.MWAA.InvokeRestApi(environment);

    const bound = {
      getEnvironment,
      createCliToken,
      createWebLoginToken,
      invokeRestApi,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl ?? request.url, "http://x");
        const pathname = url.pathname;

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (pathname === "/environment") {
          const result = yield* errorTagged(getEnvironment());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  status: result.Environment?.Status,
                  webserverUrl: result.Environment?.WebserverUrl,
                },
          );
        }

        if (pathname === "/cli-token") {
          const result = yield* errorTagged(createCliToken());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  // Never echo the Redacted token itself.
                  hasToken: result.CliToken !== undefined,
                  hostname: result.WebServerHostname,
                },
          );
        }

        if (pathname === "/web-login-token") {
          const result = yield* errorTagged(createWebLoginToken());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  hasToken: result.WebToken !== undefined,
                  hostname: result.WebServerHostname,
                  airflowIdentity: result.AirflowIdentity,
                },
          );
        }

        if (pathname === "/dags") {
          const result = yield* errorTagged(
            invokeRestApi({ Method: "GET", Path: "/dags" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  statusCode: result.RestApiStatusCode,
                  totalEntries: (
                    result.RestApiResponse as
                      | { total_entries?: number }
                      | undefined
                  )?.total_entries,
                },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.MWAA.GetEnvironmentHttp,
        AWS.MWAA.CreateCliTokenHttp,
        AWS.MWAA.CreateWebLoginTokenHttp,
        AWS.MWAA.InvokeRestApiHttp,
      ),
    ),
  ),
);
