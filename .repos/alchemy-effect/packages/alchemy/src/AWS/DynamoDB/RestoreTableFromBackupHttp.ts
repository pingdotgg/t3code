import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  RestoreTableFromBackup,
  type RestoreTableFromBackupRequest,
} from "./RestoreTableFromBackup.ts";
import type { Table } from "./Table.ts";

export const RestoreTableFromBackupHttp = Layer.effect(
  RestoreTableFromBackup,
  Effect.gen(function* () {
    const restoreTableFromBackup = yield* DynamoDB.restoreTableFromBackup;

    return Effect.fn(function* <From extends Table, To extends Table>(
      from: From,
      to: To,
    ) {
      const TargetTableName = yield* to.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.RestoreTableFromBackup(${from}, ${to}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:RestoreTableFromBackup"],
                  Resource: [Output.interpolate`${from.tableArn}/backup/*`],
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
        `AWS.DynamoDB.RestoreTableFromBackup(${from.LogicalId}, ${to.LogicalId})`,
      )(function* (request: RestoreTableFromBackupRequest) {
        return yield* restoreTableFromBackup({
          ...request,
          TargetTableName: yield* TargetTableName,
        });
      });
    });
  }),
);
