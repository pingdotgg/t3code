import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface QueryRequest extends Omit<DynamoDB.QueryInput, "TableName"> {}

export class Query extends Binding.Service<
  Query,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: QueryRequest,
    ) => Effect.Effect<DynamoDB.QueryOutput, DynamoDB.QueryError>
  >
>()("AWS.DynamoDB.Query") {}

export const QueryLive = Layer.effect(
  Query,
  Effect.gen(function* () {
    const Policy = yield* QueryPolicy;
    const query = yield* DynamoDB.query;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request: QueryRequest) {
        const tableName = yield* TableName;
        return yield* query({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);

export class QueryPolicy extends Binding.Policy<
  QueryPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.Query") {}

export const QueryPolicyLive = QueryPolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.Query(${table}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: [
              table.tableArn,
              Output.interpolate`${table.tableArn}/index/*`,
            ],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `QueryPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
