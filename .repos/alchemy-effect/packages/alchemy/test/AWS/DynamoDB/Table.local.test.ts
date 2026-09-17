/**
 * `AWS.DynamoDB.Table` under `alchemy dev`: the dualized provider deploys
 * the table into the floci emulator, including Contributor Insights
 * teardown (`DescribeContributorInsights` + CloudWatch `DescribeInsightRules`)
 * on destroy.
 *
 * Requires Docker (floci runs as a container); skipped when unavailable.
 */
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  dockerAvailable,
  rawAwsJson,
  regionOfArn,
} from "../Local/fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

test.provider.skipIf(!dockerAvailable)(
  "dev table create/destroy against floci",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const table = yield* stack.deploy(
        AWS.DynamoDB.Table("LocalTable", {
          partitionKey: "id",
          attributes: { id: "S" },
        }),
      );

      expect(table.tableArn).toContain(":000000000000:");
      expect(table.tableArn).toContain(":us-east-1:");

      const region = regionOfArn(table.tableArn);
      const described = yield* rawAwsJson({
        service: "dynamodb",
        region,
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: table.tableName },
      });
      expect(described.status).toBe(200);

      yield* stack.destroy();

      const after = yield* rawAwsJson({
        service: "dynamodb",
        region,
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: table.tableName },
      });
      expect(after.status).toBe(400);
    }),
  { timeout: 180_000 },
);
