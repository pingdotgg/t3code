import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface DeleteItemRequest extends Omit<
  DynamoDB.DeleteItemInput,
  "TableName"
> {}

export class DeleteItem extends Binding.Service<
  DeleteItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: DeleteItemRequest,
    ) => Effect.Effect<DynamoDB.DeleteItemOutput, DynamoDB.DeleteItemError>
  >
>()("AWS.DynamoDB.DeleteItem") {}

export const DeleteItemLive = Layer.effect(
  DeleteItem,
  Effect.gen(function* () {
    const Policy = yield* DeleteItemPolicy;
    const deleteItem = yield* DynamoDB.deleteItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request: DeleteItemRequest) {
        const tableName = yield* TableName;
        return yield* deleteItem({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);

export class DeleteItemPolicy extends Binding.Policy<
  DeleteItemPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.DeleteItem") {}

export const DeleteItemPolicyLive = DeleteItemPolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.DeleteItem(${table}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["dynamodb:DeleteItem"],
            Resource: [table.tableArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DeleteItemPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
