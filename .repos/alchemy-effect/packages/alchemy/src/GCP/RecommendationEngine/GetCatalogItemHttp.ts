import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import type { CatalogsCatalogItem } from "./CatalogsCatalogItem.ts";
import { bindGcpHost } from "../Host.ts";
import {
  GetCatalogItem,
  type GetCatalogItemRequest,
} from "./GetCatalogItem.ts";

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
    const run =
      yield* recommendationengine.getProjectsLocationsCatalogsCatalogItems;
    return Effect.fn(function* (item: CatalogsCatalogItem) {
      yield* bindGcpHost({
        tag: "GCP.RecommendationEngine.GetCatalogItem",
        resource: item,
        iam: [{ role: "roles/automlrecommendations.viewer" }],
      });
      const name = yield* item.name;
      return Effect.fn(
        `GCP.RecommendationEngine.GetCatalogItem(${item.LogicalId})`,
      )(function* (_request?: GetCatalogItemRequest) {
        return yield* run({ name: yield* name });
      });
    });
  }),
);
