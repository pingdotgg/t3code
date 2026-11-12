import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListAccountsWithInvalidEffectivePolicy } from "./ListAccountsWithInvalidEffectivePolicy.ts";

export const ListAccountsWithInvalidEffectivePolicyHttp = Layer.effect(
  ListAccountsWithInvalidEffectivePolicy,
  makeOrganizationsHttpBinding({
    capability: "ListAccountsWithInvalidEffectivePolicy",
    iamActions: ["organizations:ListAccountsWithInvalidEffectivePolicy"],
    operation: organizations.listAccountsWithInvalidEffectivePolicy,
  }),
);
