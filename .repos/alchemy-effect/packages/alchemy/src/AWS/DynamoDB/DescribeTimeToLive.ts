import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface DescribeTimeToLiveRequest extends Omit<
  DynamoDB.DescribeTimeToLiveInput,
  "TableName"
> {}

export class DescribeTimeToLive extends Binding.Service<
  DescribeTimeToLive,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: DescribeTimeToLiveRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeTimeToLiveOutput,
      DynamoDB.DescribeTimeToLiveError
    >
  >
>()("AWS.DynamoDB.DescribeTimeToLive") {}

export const DescribeTimeToLiveLive = Layer.effect(
  DescribeTimeToLive,
  Effect.gen(function* () {
    const Policy = yield* DescribeTimeToLivePolicy;
    const describeTimeToLive = yield* DynamoDB.describeTimeToLive;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request?: DescribeTimeToLiveRequest) {
        return yield* describeTimeToLive({
          ...request,
          TableName: yield* TableName,
        });
      });
    });
  }),
);

export class DescribeTimeToLivePolicy extends Binding.Policy<
  DescribeTimeToLivePolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.DescribeTimeToLive") {}

export const DescribeTimeToLivePolicyLive =
  DescribeTimeToLivePolicy.layer.succeed(
    Effect.fn(function* (host, table) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.DynamoDB.DescribeTimeToLive(${table}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:DescribeTimeToLive"],
                Resource: [table.tableArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeTimeToLivePolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
