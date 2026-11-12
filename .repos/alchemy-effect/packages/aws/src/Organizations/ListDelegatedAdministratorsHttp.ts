import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListDelegatedAdministrators } from "./ListDelegatedAdministrators.ts";

export const ListDelegatedAdministratorsHttp = Layer.effect(
  ListDelegatedAdministrators,
  makeOrganizationsHttpBinding({
    capability: "ListDelegatedAdministrators",
    iamActions: ["organizations:ListDelegatedAdministrators"],
    operation: organizations.listDelegatedAdministrators,
  }),
);
