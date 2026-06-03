import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListTablesRequest extends DynamoDB.ListTablesInput {}

export class ListTables extends Binding.Service<
  ListTables,
  () => Effect.Effect<
    (
      request?: ListTablesRequest,
    ) => Effect.Effect<DynamoDB.ListTablesOutput, DynamoDB.ListTablesError>
  >
>()("AWS.DynamoDB.ListTables") {}

export const ListTablesLive = Layer.effect(
  ListTables,
  Effect.gen(function* () {
    const Policy = yield* ListTablesPolicy;
    const listTables = yield* DynamoDB.listTables;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request?: ListTablesRequest) {
        return yield* listTables(request ?? {});
      });
    });
  }),
);

export class ListTablesPolicy extends Binding.Policy<
  ListTablesPolicy,
  () => Effect.Effect<void>
>()("AWS.DynamoDB.ListTables") {}

export const ListTablesPolicyLive = ListTablesPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.ListTables())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["dynamodb:ListTables"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListTablesPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
