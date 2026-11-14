import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { GetDomainMaintenanceStatus } from "./GetDomainMaintenanceStatus.ts";

export const GetDomainMaintenanceStatusHttp = Layer.effect(
  GetDomainMaintenanceStatus,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.GetDomainMaintenanceStatus",
    operation: opensearch.getDomainMaintenanceStatus,
    actions: ["es:GetDomainMaintenanceStatus"],
  }),
);
