import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { DisassociateFromAdministratorAccount } from "./DisassociateFromAdministratorAccount.ts";

export const DisassociateFromAdministratorAccountHttp = Layer.effect(
  DisassociateFromAdministratorAccount,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.DisassociateFromAdministratorAccount",
    operation: macie2.disassociateFromAdministratorAccount,
    actions: ["macie2:DisassociateFromAdministratorAccount"],
  }),
);
