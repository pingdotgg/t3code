import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListChildren } from "./ListChildren.ts";

export const ListChildrenHttp = Layer.effect(
  ListChildren,
  makeOrganizationsHttpBinding({
    capability: "ListChildren",
    iamActions: ["organizations:ListChildren"],
    operation: organizations.listChildren,
  }),
);
