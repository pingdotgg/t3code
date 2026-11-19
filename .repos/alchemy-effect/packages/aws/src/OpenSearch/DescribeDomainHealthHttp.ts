import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { DescribeDomainHealth } from "./DescribeDomainHealth.ts";

export const DescribeDomainHealthHttp = Layer.effect(
  DescribeDomainHealth,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.DescribeDomainHealth",
    operation: opensearch.describeDomainHealth,
    actions: ["es:DescribeDomainHealth"],
  }),
);
