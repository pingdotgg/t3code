import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface ListTagsOfResourceRequest extends Omit<
  DynamoDB.ListTagsOfResourceInput,
  "ResourceArn"
> {}

export class ListTagsOfResource extends Binding.Service<
  ListTagsOfResource,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: ListTagsOfResourceRequest,
    ) => Effect.Effect<
      DynamoDB.ListTagsOfResourceOutput,
      DynamoDB.ListTagsOfResourceError
    >
  >
>()("AWS.DynamoDB.ListTagsOfResource") {}

export const ListTagsOfResourceLive = Layer.effect(
  ListTagsOfResource,
  Effect.gen(function* () {
    const Policy = yield* ListTagsOfResourcePolicy;
    const listTagsOfResource = yield* DynamoDB.listTagsOfResource;

    return Effect.fn(function* <T extends Table>(table: T) {
      const ResourceArn = yield* table.tableArn;
      yield* Policy(table);
      return Effect.fn(function* (request?: ListTagsOfResourceRequest) {
        return yield* listTagsOfResource({
          ...request,
          ResourceArn: yield* ResourceArn,
        });
      });
    });
  }),
);

export class ListTagsOfResourcePolicy extends Binding.Policy<
  ListTagsOfResourcePolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.ListTagsOfResource") {}

export const ListTagsOfResourcePolicyLive =
  ListTagsOfResourcePolicy.layer.succeed(
    Effect.fn(function* (host, table) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.DynamoDB.ListTagsOfResource(${table}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:ListTagsOfResource"],
                Resource: [table.tableArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ListTagsOfResourcePolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
