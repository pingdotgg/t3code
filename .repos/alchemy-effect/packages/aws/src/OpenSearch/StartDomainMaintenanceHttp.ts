import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { StartDomainMaintenance } from "./StartDomainMaintenance.ts";

export const StartDomainMaintenanceHttp = Layer.effect(
  StartDomainMaintenance,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.StartDomainMaintenance",
    operation: opensearch.startDomainMaintenance,
    actions: ["es:StartDomainMaintenance"],
  }),
);
