import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface UpdateTimeToLiveRequest extends Omit<
  DynamoDB.UpdateTimeToLiveInput,
  "TableName"
> {}

export class UpdateTimeToLive extends Binding.Service<
  UpdateTimeToLive,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: UpdateTimeToLiveRequest,
    ) => Effect.Effect<
      DynamoDB.UpdateTimeToLiveOutput,
      DynamoDB.UpdateTimeToLiveError
    >
  >
>()("AWS.DynamoDB.UpdateTimeToLive") {}

export const UpdateTimeToLiveLive = Layer.effect(
  UpdateTimeToLive,
  Effect.gen(function* () {
    const Policy = yield* UpdateTimeToLivePolicy;
    const updateTimeToLive = yield* DynamoDB.updateTimeToLive;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request: UpdateTimeToLiveRequest) {
        return yield* updateTimeToLive({
          ...request,
          TableName: yield* TableName,
        });
      });
    });
  }),
);

export class UpdateTimeToLivePolicy extends Binding.Policy<
  UpdateTimeToLivePolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.UpdateTimeToLive") {}

export const UpdateTimeToLivePolicyLive = UpdateTimeToLivePolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.UpdateTimeToLive(${table}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["dynamodb:UpdateTimeToLive"],
              Resource: [table.tableArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `UpdateTimeToLivePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
