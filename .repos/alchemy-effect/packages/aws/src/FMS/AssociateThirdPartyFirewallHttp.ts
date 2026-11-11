import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { AssociateThirdPartyFirewall } from "./AssociateThirdPartyFirewall.ts";
import { makeFmsHttpBinding } from "./BindingHttp.ts";

export const AssociateThirdPartyFirewallHttp = Layer.effect(
  AssociateThirdPartyFirewall,
  makeFmsHttpBinding({
    capability: "AssociateThirdPartyFirewall",
    iamActions: ["fms:AssociateThirdPartyFirewall"],
    operation: fms.associateThirdPartyFirewall,
  }),
);
