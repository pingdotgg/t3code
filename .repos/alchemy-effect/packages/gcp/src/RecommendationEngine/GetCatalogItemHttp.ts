import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { CatalogsCatalogItem } from "./CatalogsCatalogItem.ts";
import { GetCatalogItem, type GetCatalogItemRequest } from "./GetCatalogItem.ts";

/**
 * HTTP implementation of {@link GetCatalogItem}.
 *
 * @layer
 * @provides GCP.RecommendationEngine.GetCatalogItem
 */
export const GetCatalogItemHttp: Layer.Layer<
  GetCatalogItem,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetCatalogItem,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(
      recommendationengine.getProjectsLocationsCatalogsCatalogItems,
    );
    return Effect.fn(function* (item: CatalogsCatalogItem) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.RecommendationEngine.GetCatalogItem(${item})`({
          iam: [{ role: "roles/automlrecommendations.viewer" }],
        });
      }
      const name = yield* item.name;
      return Effect.fn(`GCP.RecommendationEngine.GetCatalogItem(${item.LogicalId})`)(function* (
        _request?: GetCatalogItemRequest,
      ) {
        return yield* run({ name: yield* name });
      });
    });
  }),
);
