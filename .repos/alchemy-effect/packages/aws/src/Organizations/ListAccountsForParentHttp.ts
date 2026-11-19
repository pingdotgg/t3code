import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListAccountsForParent } from "./ListAccountsForParent.ts";

export const ListAccountsForParentHttp = Layer.effect(
  ListAccountsForParent,
  makeOrganizationsHttpBinding({
    capability: "ListAccountsForParent",
    iamActions: ["organizations:ListAccountsForParent"],
    operation: organizations.listAccountsForParent,
  }),
);
