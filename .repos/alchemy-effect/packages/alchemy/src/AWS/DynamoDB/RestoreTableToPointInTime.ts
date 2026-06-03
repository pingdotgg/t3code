import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableToPointInTimeRequest extends Omit<
  DynamoDB.RestoreTableToPointInTimeInput,
  "SourceTableArn" | "SourceTableName" | "TargetTableName"
> {}

export class RestoreTableToPointInTime extends Binding.Service<
  RestoreTableToPointInTime,
  <From extends Table, To extends Table>(
    from: From,
    to: To,
  ) => Effect.Effect<
    (
      request: RestoreTableToPointInTimeRequest,
    ) => Effect.Effect<
      DynamoDB.RestoreTableToPointInTimeOutput,
      DynamoDB.RestoreTableToPointInTimeError
    >
  >
>()("AWS.DynamoDB.RestoreTableToPointInTime") {}

export const RestoreTableToPointInTimeLive = Layer.effect(
  RestoreTableToPointInTime,
  Effect.gen(function* () {
    const Policy = yield* RestoreTableToPointInTimePolicy;
    const restoreTableToPointInTime = yield* DynamoDB.restoreTableToPointInTime;

    return Effect.fn(function* <From extends Table, To extends Table>(
      from: From,
      to: To,
    ) {
      const SourceTableName = yield* from.tableName;
      const TargetTableName = yield* to.tableName;
      yield* Policy(from, to);
      return Effect.fn(function* (request: RestoreTableToPointInTimeRequest) {
        return yield* restoreTableToPointInTime({
          ...request,
          SourceTableName: yield* SourceTableName,
          TargetTableName: yield* TargetTableName,
        });
      });
    });
  }),
);

export class RestoreTableToPointInTimePolicy extends Binding.Policy<
  RestoreTableToPointInTimePolicy,
  <From extends Table, To extends Table>(
    from: From,
    to: To,
  ) => Effect.Effect<void>
>()("AWS.DynamoDB.RestoreTableToPointInTime") {}

export const RestoreTableToPointInTimePolicyLive =
  RestoreTableToPointInTimePolicy.layer.succeed(
    Effect.fn(function* (host, from, to) {
      if (isFunction(host)) {
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
      } else {
        return yield* Effect.die(
          `RestoreTableToPointInTimePolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
