import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { DisassociateThirdPartyFirewall } from "./DisassociateThirdPartyFirewall.ts";

export const DisassociateThirdPartyFirewallHttp = Layer.effect(
  DisassociateThirdPartyFirewall,
  makeFmsHttpBinding({
    capability: "DisassociateThirdPartyFirewall",
    iamActions: ["fms:DisassociateThirdPartyFirewall"],
    operation: fms.disassociateThirdPartyFirewall,
  }),
);
