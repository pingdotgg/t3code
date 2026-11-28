import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DisassociateFromAdministratorAccount } from "./DisassociateFromAdministratorAccount.ts";

export const DisassociateFromAdministratorAccountHttp = Layer.effect(
  DisassociateFromAdministratorAccount,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DisassociateFromAdministratorAccount",
    operation: securityhub.disassociateFromAdministratorAccount,
    actions: ["securityhub:DisassociateFromAdministratorAccount"],
  }),
);
