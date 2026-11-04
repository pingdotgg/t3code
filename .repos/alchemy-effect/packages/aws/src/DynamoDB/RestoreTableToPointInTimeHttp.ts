import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import {
  RestoreTableToPointInTime,
  type RestoreTableToPointInTimeRequest,
} from "./RestoreTableToPointInTime.ts";
import type { Table } from "./Table.ts";

export const RestoreTableToPointInTimeHttp = Layer.effect(
  RestoreTableToPointInTime,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* <From extends Table, To extends Table>(from: From, to: To) {
      const SourceTableName = yield* from.tableName;
      const TargetTableName = yield* to.tableName;
      yield* grantTables(
        `AWS.DynamoDB.RestoreTableToPointInTime(${from.LogicalId}, ${to.LogicalId})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:RestoreTableToPointInTime"],
            Resource: [from.tableArn],
          },
          {
            Effect: "Allow",
            Action: [
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:Query",
              "dynamodb:Scan",
              "dynamodb:BatchWriteItem",
            ],
            Resource: [to.tableArn],
          },
        ],
      );
      // Restores stay in-region: both tables must share it.
      const restoreTableToPointInTime = yield* AWSBindings.withCredentials(
        DynamoDB.restoreTableToPointInTime,
        tablesRegion([from, to]),
      );
      return Effect.fn(
        `AWS.DynamoDB.RestoreTableToPointInTime(${from.LogicalId}, ${to.LogicalId})`,
      )(function* (request: RestoreTableToPointInTimeRequest) {
        return yield* restoreTableToPointInTime({
          ...request,
          SourceTableName: yield* SourceTableName,
          TargetTableName: yield* TargetTableName,
        });
      });
    });
  }),
);
