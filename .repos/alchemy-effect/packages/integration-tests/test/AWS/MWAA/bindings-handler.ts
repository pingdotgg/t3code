import * as AWS from "@alchemy.run/aws";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { MwaaNetwork } from "./network.ts";

export class MWAATestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "MWAATestFunction",
) {}

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
 * (~20-30 minutes to provision, billed hourly while it exists — skipped under
 * `--fast`) plus its supporting cast (private VPC networking with a NAT
 * gateway, versioned DAGs bucket, execution role) and a Lambda bound to all
 * four MWAA bindings.
 */
export default MWAATestFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const { subnetIds, securityGroupIds } = yield* MwaaNetwork(
      "MWAABindingsNetwork",
      "10.87.0.0/16",
    );

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
              Resource: [bucket.bucketArn, Output.interpolate`${bucket.bucketArn}/*`],
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
      securityGroupIds,
      environmentClass: "mw1.small",
      maxWorkers: 2,
      minWorkers: 1,
      webserverAccessMode: "PUBLIC_ONLY",
      tags: { fixture: "mwaa-bindings" },
    });

    const getEnvironment = yield* AWS.MWAA.GetEnvironment(environment);
    const createCliToken = yield* AWS.MWAA.CreateCliToken(environment);
    const createWebLoginToken = yield* AWS.MWAA.CreateWebLoginToken(environment);
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
          const result = yield* errorTagged(invokeRestApi({ Method: "GET", Path: "/dags" }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  statusCode: result.RestApiStatusCode,
                  totalEntries: (result.RestApiResponse as { total_entries?: number } | undefined)
                    ?.total_entries,
                },
          );
        }

        return yield* HttpServerResponse.json({ error: "Not found", pathname }, { status: 404 });
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
