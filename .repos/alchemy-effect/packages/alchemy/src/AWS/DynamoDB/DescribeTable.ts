import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface DescribeTableRequest extends Omit<
  DynamoDB.DescribeTableInput,
  "TableName"
> {}

export class DescribeTable extends Binding.Service<
  DescribeTable,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: DescribeTableRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeTableOutput,
      DynamoDB.DescribeTableError
    >
  >
>()("AWS.DynamoDB.DescribeTable") {}

export const DescribeTableLive = Layer.effect(
  DescribeTable,
  Effect.gen(function* () {
    const Policy = yield* DescribeTablePolicy;
    const describeTable = yield* DynamoDB.describeTable;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request?: DescribeTableRequest) {
        return yield* describeTable({
          ...request,
          TableName: yield* TableName,
        });
      });
    });
  }),
);

export class DescribeTablePolicy extends Binding.Policy<
  DescribeTablePolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.DescribeTable") {}

export const DescribeTablePolicyLive = DescribeTablePolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.DescribeTable(${table}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["dynamodb:DescribeTable"],
            Resource: [table.tableArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DescribeTablePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
