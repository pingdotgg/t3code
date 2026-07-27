import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Collection } from "./Collection.ts";
import { GetCollection } from "./GetCollection.ts";

// Bespoke (not the shared scaffolding): BatchGetCollection takes an `ids`
// array rather than a single injected `id`, and the callable unwraps the
// batch response to the bound collection's detail.
export const GetCollectionHttp = Layer.effect(
  GetCollection,
  Effect.gen(function* () {
    const op = yield* aoss.batchGetCollection;

    return Effect.fn(function* (collection: Collection) {
      const CollectionId = yield* collection.collectionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.OpenSearchServerless.GetCollection(${collection}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["aoss:BatchGetCollection"],
                  Resource: [Output.interpolate`${collection.collectionArn}`],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.OpenSearchServerless.GetCollection(${collection.LogicalId})`,
      )(function* () {
        const response = yield* op({ ids: [yield* CollectionId] });
        return response.collectionDetails?.[0];
      });
    });
  }),
);
