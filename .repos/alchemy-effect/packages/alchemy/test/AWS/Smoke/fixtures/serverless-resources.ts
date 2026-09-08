import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Every resource the serverless story is composed of, shared between the
 * API function (which binds to all of them), the worker function (which
 * consumes the jobs queue), and the test's stack program (which wires the
 * HTTP API's JWT authorizer to the pool). Declared once as a
 * Context.Service so all consumers observe the SAME logical resources.
 */
export class ServerlessResources extends Context.Service<
  ServerlessResources,
  {
    pool: AWS.Cognito.UserPool;
    client: AWS.Cognito.UserPoolClient;
    table: AWS.DynamoDB.Table;
    bucket: AWS.S3.Bucket;
    jobsQueue: AWS.SQS.Queue;
    resultsQueue: AWS.SQS.Queue;
    machine: AWS.StepFunctions.StateMachine;
  }
>()("ServerlessResources") {}

export const ServerlessResourcesLive = Layer.effect(
  ServerlessResources,
  Effect.gen(function* () {
    const pool = yield* AWS.Cognito.UserPool("SmokeUserPool", {
      passwordPolicy: {
        minimumLength: 12,
        requireSymbols: false,
      },
      accountRecovery: [{ name: "admin_only", priority: 1 }],
      tags: { Purpose: "serverless-smoke-fixture" },
    });
    const client = yield* AWS.Cognito.UserPoolClient("SmokeUserPoolClient", {
      userPoolId: pool.userPoolId,
      explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
    });
    const table = yield* AWS.DynamoDB.Table("SmokeTable", {
      partitionKey: "pk",
      sortKey: "sk",
      attributes: { pk: "S", sk: "S" },
    });
    const bucket = yield* AWS.S3.Bucket("SmokeBucket", {
      forceDestroy: true,
    });
    const jobsQueue = yield* AWS.SQS.Queue("SmokeJobsQueue");
    const resultsQueue = yield* AWS.SQS.Queue("SmokeResultsQueue");
    const machine = yield* AWS.StepFunctions.StateMachine(
      "SmokeExpressMachine",
      {
        type: "EXPRESS",
        definition: {
          StartAt: "Compute",
          States: {
            Compute: {
              Type: "Pass",
              Parameters: { "echo.$": "$", computed: true },
              End: true,
            },
          },
        },
      },
    );
    return { pool, client, table, bucket, jobsQueue, resultsQueue, machine };
  }),
);
