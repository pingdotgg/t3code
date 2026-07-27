import * as AWS from "@/AWS";
import { Database, Table } from "@/AWS/Timestream";
import {
  withQueryEndpoint,
  withWriteEndpoint,
} from "@/AWS/Timestream/internal";
import * as Test from "@/Test/Alchemy";
import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as TSW from "@distilled.cloud/aws/timestream-write";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Amazon Timestream for LiveAnalytics is closed to new AWS customers; accounts
// that were not already onboarded receive `TimestreamNotOnboarded` (a
// specialized AccessDenied) on every operation, including the endpoint-
// discovery call every request must make first. The ungated probes assert that
// gate is surfaced as a typed error; the full lifecycle is gated behind
// AWS_TEST_TIMESTREAM=1 so an onboarded account can run it unchanged.
describe("AWS.Timestream.Database", () => {
  test.provider(
    "write DescribeEndpoints reports typed TimestreamNotOnboarded",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* TSW.describeEndpoints({}).pipe(Effect.flip);
        expect(error._tag).toBe("TimestreamNotOnboarded");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "query DescribeEndpoints reports typed TimestreamNotOnboarded",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* TSQ.describeEndpoints({}).pipe(Effect.flip);
        expect(error._tag).toBe("TimestreamNotOnboarded");
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_TIMESTREAM)(
    "create database + table, write + query, then delete",
    (stack) =>
      Effect.gen(function* () {
        const { database, table } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Database("Metrics");
            const table = yield* Table("Cpu", {
              databaseName: database.databaseName,
              retentionProperties: {
                memoryStoreRetention: "6 hours",
                magneticStoreRetention: "30 days",
              },
            });
            return { database, table };
          }),
        );

        expect(database.databaseArn).toBeDefined();
        expect(table.tableArn).toBeDefined();
        expect(table.tableStatus).toBe("ACTIVE");

        // Out-of-band verification via distilled through the discovered
        // endpoint.
        const described = yield* withWriteEndpoint(
          TSW.describeTable({
            DatabaseName: database.databaseName,
            TableName: table.tableName,
          }),
        );
        expect(described.Table?.TableStatus).toBe("ACTIVE");

        // Write a point and query it back.
        yield* withWriteEndpoint(
          TSW.writeRecords({
            DatabaseName: database.databaseName,
            TableName: table.tableName,
            Records: [
              {
                Dimensions: [{ Name: "host", Value: "web-1" }],
                MeasureName: "cpu",
                MeasureValue: "42.0",
                MeasureValueType: "DOUBLE",
                Time: `${Date.now()}`,
                TimeUnit: "MILLISECONDS",
              },
            ],
          }),
        );

        const queried = yield* withQueryEndpoint(
          TSQ.query({
            QueryString: `SELECT COUNT(*) FROM "${database.databaseName}"."${table.tableName}"`,
          }),
        );
        expect(queried.Rows.length).toBeGreaterThan(0);

        yield* stack.destroy();

        const gone = yield* withWriteEndpoint(
          TSW.describeDatabase({ DatabaseName: database.databaseName }),
        ).pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
        expect(gone).toBe(true);
      }),
    { timeout: 300_000 },
  );
});
