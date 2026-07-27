import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { DescribeDomainChangeProgress } from "./DescribeDomainChangeProgress.ts";

export const DescribeDomainChangeProgressHttp = Layer.effect(
  DescribeDomainChangeProgress,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.DescribeDomainChangeProgress",
    operation: opensearch.describeDomainChangeProgress,
    actions: ["es:DescribeDomainChangeProgress"],
  }),
);
