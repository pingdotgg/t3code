import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListPolicies } from "./ListPolicies.ts";

export const ListPoliciesHttp = Layer.effect(
  ListPolicies,
  makeOrganizationsHttpBinding({
    capability: "ListPolicies",
    iamActions: ["organizations:ListPolicies"],
    operation: organizations.listPolicies,
  }),
);
