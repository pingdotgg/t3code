import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { ListDomainNames } from "./ListDomainNames.ts";

export const ListDomainNamesHttp = Layer.effect(
  ListDomainNames,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.ListDomainNames",
    operation: opensearch.listDomainNames,
    actions: ["es:ListDomainNames"],
  }),
);
