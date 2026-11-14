import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetAdministratorAccount } from "./GetAdministratorAccount.ts";

export const GetAdministratorAccountHttp = Layer.effect(
  GetAdministratorAccount,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetAdministratorAccount",
    operation: macie2.getAdministratorAccount,
    actions: ["macie2:GetAdministratorAccount"],
  }),
);
