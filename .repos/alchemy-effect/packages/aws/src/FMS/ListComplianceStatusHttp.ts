import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListComplianceStatus } from "./ListComplianceStatus.ts";

export const ListComplianceStatusHttp = Layer.effect(
  ListComplianceStatus,
  makeFmsHttpBinding({
    capability: "ListComplianceStatus",
    iamActions: ["fms:ListComplianceStatus"],
    operation: fms.listComplianceStatus,
  }),
);
