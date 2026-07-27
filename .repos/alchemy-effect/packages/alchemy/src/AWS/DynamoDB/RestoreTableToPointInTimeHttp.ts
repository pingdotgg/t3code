import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  RestoreTableToPointInTime,
  type RestoreTableToPointInTimeRequest,
} from "./RestoreTableToPointInTime.ts";
import type { Table } from "./Table.ts";

export const RestoreTableToPointInTimeHttp = Layer.effect(
  RestoreTableToPointInTime,
  Effect.gen(function* () {
    const restoreTableToPointInTime = yield* DynamoDB.restoreTableToPointInTime;

    return Effect.fn(function* <From extends Table, To extends Table>(
      from: From,
      to: To,
    ) {
      const SourceTableName = yield* from.tableName;
      const TargetTableName = yield* to.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.RestoreTableToPointInTime(${from}, ${to}))`(
            {
              policyStatements: [
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
            },
          );
        }
      }
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
