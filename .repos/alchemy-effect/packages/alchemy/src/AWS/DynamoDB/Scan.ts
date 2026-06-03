import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface ScanRequest extends Omit<DynamoDB.ScanInput, "TableName"> {}

export class Scan extends Binding.Service<
  Scan,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: ScanRequest,
    ) => Effect.Effect<DynamoDB.ScanOutput, DynamoDB.ScanError>
  >
>()("AWS.DynamoDB.Scan") {}

export const ScanLive = Layer.effect(
  Scan,
  Effect.gen(function* () {
    const Policy = yield* ScanPolicy;
    const scan = yield* DynamoDB.scan;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request: ScanRequest) {
        const tableName = yield* TableName;
        return yield* scan({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);

export class ScanPolicy extends Binding.Policy<
  ScanPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.Scan") {}

export const ScanPolicyLive = ScanPolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.Scan(${table}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["dynamodb:Scan"],
            Resource: [
              table.tableArn,
              Output.interpolate`${table.tableArn}/index/*`,
            ],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ScanPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
