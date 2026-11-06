import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { DescribeDomainAutoTunes } from "./DescribeDomainAutoTunes.ts";

export const DescribeDomainAutoTunesHttp = Layer.effect(
  DescribeDomainAutoTunes,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.DescribeDomainAutoTunes",
    operation: opensearch.describeDomainAutoTunes,
    actions: ["es:DescribeDomainAutoTunes"],
  }),
);
