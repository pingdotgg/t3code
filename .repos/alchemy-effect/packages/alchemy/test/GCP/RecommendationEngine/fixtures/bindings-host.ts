import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const TITLE = "Cotton tee";

export const Shirt = GCP.RecommendationEngine.CatalogsCatalogItem("Shirt", {
  title: TITLE,
  categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
});

/**
 * Effect-native Cloud Run service exercising every Recommendations AI
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class RecommendationEngineBindingsHost extends GCP.Function<RecommendationEngineBindingsHost>()(
  "RecommendationEngineBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getCatalogItem =
      yield* GCP.RecommendationEngine.GetCatalogItem(Shirt);

    return {
      fetch: serveProbes({
        getCatalogItem: getCatalogItem(),
      }),
    };
  }).pipe(Effect.provide(GCP.RecommendationEngine.GetCatalogItemHttp)),
) {}
