import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { ListDomainMaintenances } from "./ListDomainMaintenances.ts";

export const ListDomainMaintenancesHttp = Layer.effect(
  ListDomainMaintenances,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.ListDomainMaintenances",
    operation: opensearch.listDomainMaintenances,
    actions: ["es:ListDomainMaintenances"],
  }),
);
