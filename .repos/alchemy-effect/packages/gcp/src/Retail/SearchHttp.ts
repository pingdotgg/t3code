import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Layer from "effect/Layer";
import { makeServingConfigHttpBinding } from "./BindingHttp.ts";
import { Search } from "./Search.ts";

/**
 * HTTP implementation of {@link Search}.
 *
 * @layer
 * @provides GCP.Retail.Search
 */
export const SearchHttp = Layer.effect(
  Search,
  makeServingConfigHttpBinding({
    tag: "GCP.Retail.Search",
    operation: retail.searchProjectsLocationsCatalogsServingConfigs,
    iam: { role: "roles/retail.viewer" },
  }),
);
