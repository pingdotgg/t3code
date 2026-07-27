import * as AWS from "@/AWS";
import { DataSource, Index } from "@/AWS/Kendra";
import * as Test from "@/Test/Alchemy";
import * as kendra from "@distilled.cloud/aws/kendra";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Kendra is reachable but an index takes ~20-30 minutes to provision and
// bills hourly once ACTIVE (Developer edition included after free tier).
// The ungated probes assert the distilled wiring surfaces the typed
// not-found errors the provider's read/delete paths depend on; the full
// lifecycle is gated behind AWS_TEST_SLOW=1.
describe("AWS.Kendra.Index", () => {
  test.provider(
    "describeIndex on a nonexistent id yields a typed ResourceNotFoundException",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* kendra
          .describeIndex({ Id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "describeDataSource on a nonexistent index yields a typed ResourceNotFoundException",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* kendra
          .describeDataSource({
            Id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            IndexId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
    "create developer index + S3 data source, update, destroy, verify gone",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deploy = (props: { description?: string }) =>
          stack.deploy(
            Effect.gen(function* () {
              // Role Kendra assumes to publish CloudWatch metrics/logs.
              const indexRole = yield* AWS.IAM.Role("KendraIndexRole", {
                assumeRolePolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: ["kendra.amazonaws.com"] },
                      Action: ["sts:AssumeRole"],
                    },
                  ],
                },
                inlinePolicies: {
                  observability: {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: ["cloudwatch:PutMetricData"],
                        Resource: ["*"],
                        Condition: {
                          StringEquals: {
                            "cloudwatch:namespace": "AWS/Kendra",
                          },
                        },
                      },
                      {
                        Effect: "Allow",
                        Action: [
                          "logs:DescribeLogGroups",
                          "logs:CreateLogGroup",
                          "logs:DescribeLogStreams",
                          "logs:CreateLogStream",
                          "logs:PutLogEvents",
                        ],
                        Resource: ["*"],
                      },
                    ],
                  },
                },
              });

              const bucket = yield* AWS.S3.Bucket("KendraDocs", {
                forceDestroy: true,
              });

              // Role Kendra assumes to crawl the S3 bucket.
              const dataSourceRole = yield* AWS.IAM.Role("KendraDataRole", {
                assumeRolePolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: ["kendra.amazonaws.com"] },
                      Action: ["sts:AssumeRole"],
                    },
                  ],
                },
                inlinePolicies: {
                  s3: {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: ["s3:GetObject", "s3:ListBucket"],
                        Resource: ["*"],
                      },
                      {
                        Effect: "Allow",
                        Action: [
                          "kendra:BatchPutDocument",
                          "kendra:BatchDeleteDocument",
                        ],
                        Resource: ["*"],
                      },
                    ],
                  },
                },
              });

              const index = yield* Index("Search", {
                edition: "DEVELOPER_EDITION",
                roleArn: indexRole.roleArn,
                description: props.description,
                tags: { Environment: "test" },
              });

              const source = yield* DataSource("Docs", {
                indexId: index.id,
                type: "S3",
                roleArn: dataSourceRole.roleArn,
                configuration: {
                  S3Configuration: {
                    BucketName: bucket.bucketName,
                  },
                },
              });

              return { index, source };
            }),
          );

        // Create — reconcile waits (bounded) for ACTIVE.
        const { index, source } = yield* deploy({});
        expect(index.id).toBeDefined();
        expect(index.status).toBe("ACTIVE");
        expect(index.edition).toBe("DEVELOPER_EDITION");
        expect(source.id).toBeDefined();
        expect(source.status).toBe("ACTIVE");
        expect(source.type).toBe("S3");

        // Out-of-band verification via distilled.
        const described = yield* kendra.describeIndex({ Id: index.id });
        expect(described.Status).toBe("ACTIVE");

        // Update in place — description flows through UpdateIndex.
        const updated = yield* deploy({ description: "updated by test" });
        expect(updated.index.id).toBe(index.id);
        const redescribed = yield* kendra.describeIndex({ Id: index.id });
        expect(redescribed.Description).toBe("updated by test");

        yield* stack.destroy();

        // Typed wait-until-gone.
        yield* Effect.gen(function* () {
          const gone = yield* kendra.describeIndex({ Id: index.id }).pipe(
            Effect.map((d) => d.Status === "DELETING"),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          if (!gone) {
            return yield* Effect.fail({ _tag: "StillExists" as const });
          }
        }).pipe(
          Effect.retry({
            while: (e: { _tag: string }) => e._tag === "StillExists",
            schedule: Schedule.max([
              Schedule.spaced("15 seconds"),
              Schedule.recurs(40),
            ]),
          }),
        );
      }),
    { timeout: 3_600_000 },
  );
});
