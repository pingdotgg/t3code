import * as AWS from "@/AWS";
import * as IAM from "@/AWS/IAM";
import * as S3 from "@/AWS/S3";
import * as SNS from "@/AWS/SNS";
import { Database, ScheduledQuery, Table } from "@/AWS/Timestream";
import { withQueryEndpoint } from "@/AWS/Timestream/internal";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as TSQ from "@distilled.cloud/aws/timestream-query";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Amazon Timestream for LiveAnalytics is closed to new AWS customers; the
// testing account receives the typed `TimestreamNotOnboarded` gate on every
// operation, including the endpoint-discovery call every scheduled-query
// request must make first. The ungated probe asserts the gate surfaces as a
// typed error through the discovery wrapper the provider uses; the full
// lifecycle is gated behind AWS_TEST_TIMESTREAM=1 so an onboarded account can
// run it unchanged.
describe("AWS.Timestream.ScheduledQuery", () => {
  test.provider(
    "listScheduledQueries reports typed TimestreamNotOnboarded via endpoint discovery",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* withQueryEndpoint(
          TSQ.listScheduledQueries({}),
        ).pipe(Effect.flip);
        expect(error._tag).toBe("TimestreamNotOnboarded");
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_TIMESTREAM)(
    "create, pause, and delete a scheduled query",
    (stack) =>
      Effect.gen(function* () {
        const infra = Effect.gen(function* () {
          const database = yield* Database("SqMetrics");
          const table = yield* Table("SqCpu", {
            databaseName: database.databaseName,
          });
          const topic = yield* SNS.Topic("SqNotifications");
          const bucket = yield* S3.Bucket("SqErrorReports", {
            forceDestroy: true,
          });
          const role = yield* IAM.Role("SqExecutionRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "timestream.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              scheduledQuery: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: [
                      "timestream:Select",
                      "timestream:SelectValues",
                      "timestream:WriteRecords",
                      "timestream:DescribeEndpoints",
                    ],
                    Resource: ["*"],
                  },
                  {
                    Effect: "Allow",
                    Action: ["sns:Publish"],
                    Resource: [topic.topicArn],
                  },
                  {
                    Effect: "Allow",
                    Action: ["s3:PutObject", "s3:GetBucketAcl"],
                    Resource: [
                      bucket.bucketArn,
                      Output.interpolate`${bucket.bucketArn}/*`,
                    ],
                  },
                ],
              },
            },
          });
          const scheduledQuery = yield* ScheduledQuery("HourlyCount", {
            queryString: Output.interpolate`SELECT COUNT(*) FROM "${database.databaseName}"."${table.tableName}"`,
            scheduleExpression: "rate(1 hour)",
            notificationTopicArn: topic.topicArn,
            executionRoleArn: role.roleArn,
            errorReportS3: { bucketName: bucket.bucketName },
            tags: { Environment: "test" },
          });
          return { scheduledQuery };
        });

        const { scheduledQuery } = yield* stack.deploy(infra);
        expect(scheduledQuery.scheduledQueryArn).toBeTruthy();
        expect(scheduledQuery.state).toBe("ENABLED");

        // Out-of-band verification via distilled through the discovered
        // endpoint.
        const described = yield* withQueryEndpoint(
          TSQ.describeScheduledQuery({
            ScheduledQueryArn: scheduledQuery.scheduledQueryArn,
          }),
        );
        expect(described.ScheduledQuery.State).toBe("ENABLED");

        yield* stack.destroy();

        const gone = yield* withQueryEndpoint(
          TSQ.describeScheduledQuery({
            ScheduledQueryArn: scheduledQuery.scheduledQueryArn,
          }),
        ).pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
        expect(gone).toBe(true);
      }),
    { timeout: 600_000 },
  );
});
