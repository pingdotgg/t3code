import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/**
 * Retail only serves projects that accepted the Retail data use terms (a
 * one-time console step); until then every call fails with
 * `RetailDataUseTermsNotAccepted`. `GCP_TEST_RETAIL_TERMS=1` opts in once
 * accepted; the gate is forwarded to the host's environment so the deployed
 * runtime binds the same set.
 */
export const retailEnabled = !!process.env.GCP_TEST_RETAIL_TERMS;

/** Product the search should find; declared only when enabled. */
export const Shirt = GCP.Retail.CatalogsBranchesProduct("Shirt", {
  title: "Cotton tee",
  categories: ["Apparel > T-Shirts"],
});

/** Serving config the bindings bind; declared only when enabled. */
export const Serving = GCP.Retail.CatalogsServingConfig("Search", {
  displayName: "search",
});

const servingProbes = Effect.gen(function* () {
  const search = yield* GCP.Retail.Search(Serving);
  const predict = yield* GCP.Retail.Predict(Serving);
  return {
    search: search({
      body: { visitorId: "alchemy-visitor", query: "tee", pageSize: 5 },
    }),
    predict: predict({
      body: {
        validateOnly: true,
        userEvent: { eventType: "detail-page-view", visitorId: "visitor-1" },
      },
    }),
  };
});

/**
 * Effect-native Cloud Run service exercising every Retail binding as its own
 * runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class RetailBindingsHost extends GCP.Function<RetailBindingsHost>()(
  "RetailBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: { GCP_TEST_RETAIL_TERMS: retailEnabled ? "1" : "" },
  },
  Effect.gen(function* () {
    const serving = retailEnabled ? yield* servingProbes : {};
    return { fetch: serveProbes({ ...serving }) };
  }).pipe(
    Effect.provide(GCP.Retail.SearchHttp),
    Effect.provide(GCP.Retail.PredictHttp),
  ),
) {}
