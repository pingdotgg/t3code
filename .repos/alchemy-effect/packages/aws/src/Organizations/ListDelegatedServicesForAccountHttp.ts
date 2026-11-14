import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListDelegatedServicesForAccount } from "./ListDelegatedServicesForAccount.ts";

export const ListDelegatedServicesForAccountHttp = Layer.effect(
  ListDelegatedServicesForAccount,
  makeOrganizationsHttpBinding({
    capability: "ListDelegatedServicesForAccount",
    iamActions: ["organizations:ListDelegatedServicesForAccount"],
    operation: organizations.listDelegatedServicesForAccount,
  }),
);
