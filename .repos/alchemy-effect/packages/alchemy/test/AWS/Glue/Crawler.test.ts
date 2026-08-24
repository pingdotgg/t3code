import * as AWS from "@/AWS";
import { Crawler, Database } from "@/AWS/Glue";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as glue from "@distilled.cloud/aws/glue";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const getCrawler = (name: string) =>
  glue.getCrawler({ Name: name }).pipe(
    Effect.map((r) => r.Crawler),
    Effect.catchTag("EntityNotFoundException", () => Effect.succeed(undefined)),
  );

const crawlerRole = () =>
  Role("GlueCrawlerRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "glue.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole",
      "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
    ],
  });

test.provider("create, update, delete Glue crawler definition", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const database = yield* Database("CrawlerDb", {});
        const bucket = yield* Bucket("CrawlerBucket", { forceDestroy: true });
        const role = yield* crawlerRole();
        const crawler = yield* Crawler("EventsCrawler", {
          role: role.roleArn,
          databaseName: database.databaseName,
          targets: {
            s3Targets: [
              { path: Output.interpolate`s3://${bucket.bucketName}/data/` },
            ],
          },
          tablePrefix: "raw_",
          tags: { Environment: "test" },
        });
        return { database, bucket, crawler };
      }),
    );

    expect(created.crawler.crawlerName).toBeDefined();
    expect(created.crawler.crawlerArn).toContain(
      `:crawler/${created.crawler.crawlerName}`,
    );

    // out-of-band verification
    const observed = yield* getCrawler(created.crawler.crawlerName);
    expect(observed?.Name).toEqual(created.crawler.crawlerName);
    expect(observed?.DatabaseName).toEqual(created.database.databaseName);
    expect(observed?.TablePrefix).toEqual("raw_");
    expect(observed?.Targets?.S3Targets?.[0]?.Path).toEqual(
      `s3://${created.bucket.bucketName}/data/`,
    );

    // tags (crawlers ARE ARN-taggable)
    const tags = yield* glue.getTags({
      ResourceArn: created.crawler.crawlerArn,
    });
    expect(tags.Tags?.["alchemy::id"]).toBeDefined();
    expect(tags.Tags?.Environment).toEqual("test");

    // update: description + schedule
    yield* stack.deploy(
      Effect.gen(function* () {
        const database = yield* Database("CrawlerDb", {});
        const bucket = yield* Bucket("CrawlerBucket", { forceDestroy: true });
        const role = yield* crawlerRole();
        const crawler = yield* Crawler("EventsCrawler", {
          role: role.roleArn,
          databaseName: database.databaseName,
          description: "crawls the events prefix",
          targets: {
            s3Targets: [
              { path: Output.interpolate`s3://${bucket.bucketName}/data/` },
            ],
          },
          tablePrefix: "raw_",
          schedule: "cron(0 12 * * ? *)",
          schemaChangePolicy: {
            updateBehavior: "UPDATE_IN_DATABASE",
            deleteBehavior: "DEPRECATE_IN_DATABASE",
          },
          tags: { Environment: "test" },
        });
        return { crawler };
      }),
    );

    const reobserved = yield* getCrawler(created.crawler.crawlerName);
    expect(reobserved?.Description).toEqual("crawls the events prefix");
    expect(reobserved?.Schedule?.ScheduleExpression).toEqual(
      "cron(0 12 * * ? *)",
    );
    expect(reobserved?.SchemaChangePolicy?.UpdateBehavior).toEqual(
      "UPDATE_IN_DATABASE",
    );

    yield* stack.destroy();
    const gone = yield* getCrawler(created.crawler.crawlerName);
    expect(gone).toBeUndefined();
  }),
);

// A live crawl takes ~2-4 minutes end to end — gated behind AWS_TEST_SLOW=1.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "run a live crawl that populates the catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* Database("LiveCrawlDb", {});
          const bucket = yield* Bucket("LiveCrawlBucket", {
            forceDestroy: true,
          });
          const role = yield* crawlerRole();
          const crawler = yield* Crawler("LiveCrawler", {
            role: role.roleArn,
            databaseName: database.databaseName,
            targets: {
              s3Targets: [
                { path: Output.interpolate`s3://${bucket.bucketName}/data/` },
              ],
            },
          });
          return { database, bucket, crawler };
        }),
      );

      // seed a CSV object so the crawler infers a table
      yield* s3.putObject({
        Bucket: deployed.bucket.bucketName,
        Key: "data/events/part-0.csv",
        Body: new TextEncoder().encode("id,amount\n1,10.5\n2,20.0\n"),
        ContentType: "text/csv",
      });

      yield* glue.startCrawler({ Name: deployed.crawler.crawlerName });

      // poll until the crawler returns to READY with a terminal last-crawl
      const finalState = yield* getCrawler(deployed.crawler.crawlerName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (c) =>
            c?.State === "READY" && c?.LastCrawl?.Status !== undefined,
          times: 20,
        }),
      );
      expect(finalState?.LastCrawl?.Status).toEqual("SUCCEEDED");

      // a table should now exist in the catalog
      const tables = yield* glue.getTables({
        DatabaseName: deployed.database.databaseName,
      });
      expect(tables.TableList?.length ?? 0).toBeGreaterThan(0);

      yield* stack.destroy();
    }),
  { timeout: 360_000 },
);
