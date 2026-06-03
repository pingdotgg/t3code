import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface ExecuteTransactionRequest
  extends DynamoDB.ExecuteTransactionInput {}

type ExecuteTransactionTables = [Table, ...Table[]];

export class ExecuteTransaction extends Binding.Service<
  ExecuteTransaction,
  (
    ...tables: ExecuteTransactionTables
  ) => Effect.Effect<
    (
      request: ExecuteTransactionRequest,
    ) => Effect.Effect<
      DynamoDB.ExecuteTransactionOutput,
      DynamoDB.ExecuteTransactionError
    >
  >
>()("AWS.DynamoDB.ExecuteTransaction") {}

export const ExecuteTransactionLive = Layer.effect(
  ExecuteTransaction,
  Effect.gen(function* () {
    const Policy = yield* ExecuteTransactionPolicy;
    const executeTransaction = yield* DynamoDB.executeTransaction;

    return Effect.fn(function* (...tables: ExecuteTransactionTables) {
      yield* Policy(...tables);
      return Effect.fn(function* (request: ExecuteTransactionRequest) {
        return yield* executeTransaction(request);
      });
    });
  }),
);

export class ExecuteTransactionPolicy extends Binding.Policy<
  ExecuteTransactionPolicy,
  (...tables: ExecuteTransactionTables) => Effect.Effect<void>
>()("AWS.DynamoDB.ExecuteTransaction") {}

export const ExecuteTransactionPolicyLive =
  ExecuteTransactionPolicy.layer.succeed(
    Effect.fn(function* (host, ...tables: ExecuteTransactionTables) {
      const sortedTables = [...tables].sort((a, b) =>
        a.LogicalId.localeCompare(b.LogicalId),
      );

      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.DynamoDB.ExecuteTransaction(${sortedTables}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "dynamodb:PartiQLSelect",
                  "dynamodb:PartiQLInsert",
                  "dynamodb:PartiQLUpdate",
                  "dynamodb:PartiQLDelete",
                ],
                Resource: sortedTables.map((table) => table.tableArn),
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ExecuteTransactionPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
