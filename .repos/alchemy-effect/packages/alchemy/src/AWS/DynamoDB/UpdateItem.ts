import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface UpdateItemRequest extends Omit<
  DynamoDB.UpdateItemInput,
  "TableName"
> {}

export class UpdateItem extends Binding.Service<
  UpdateItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: UpdateItemRequest,
    ) => Effect.Effect<DynamoDB.UpdateItemOutput, DynamoDB.UpdateItemError>
  >
>()("AWS.DynamoDB.UpdateItem") {}

export const UpdateItemLive = Layer.effect(
  UpdateItem,
  Effect.gen(function* () {
    const Policy = yield* UpdateItemPolicy;
    const updateItem = yield* DynamoDB.updateItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request: UpdateItemRequest) {
        const tableName = yield* TableName;
        return yield* updateItem({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);

export class UpdateItemPolicy extends Binding.Policy<
  UpdateItemPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.UpdateItem") {}

export const UpdateItemPolicyLive = UpdateItemPolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.UpdateItem(${table}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["dynamodb:UpdateItem"],
            Resource: [table.tableArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `UpdateItemPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
