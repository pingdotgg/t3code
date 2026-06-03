import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface PutItemRequest extends Omit<
  DynamoDB.PutItemInput,
  "TableName"
> {}

export class PutItem extends Binding.Service<
  PutItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: PutItemRequest,
    ) => Effect.Effect<DynamoDB.PutItemOutput, DynamoDB.PutItemError>
  >
>()("AWS.DynamoDB.PutItem") {}

export const PutItemLive = Layer.effect(
  PutItem,
  Effect.gen(function* () {
    const bind = yield* PutItemPolicy;
    const putItem = yield* DynamoDB.putItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* bind(table);
      return Effect.fn(function* (request: PutItemRequest) {
        const tableName = yield* TableName;
        return yield* putItem({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);

export class PutItemPolicy extends Binding.Policy<
  PutItemPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.PutItem") {}

export const PutItemPolicyLive = PutItemPolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.PutItem(${table}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["dynamodb:PutItem"],
            Resource: [table.tableArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutItemPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
