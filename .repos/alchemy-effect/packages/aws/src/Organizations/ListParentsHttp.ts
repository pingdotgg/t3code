import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListParents } from "./ListParents.ts";

export const ListParentsHttp = Layer.effect(
  ListParents,
  makeOrganizationsHttpBinding({
    capability: "ListParents",
    iamActions: ["organizations:ListParents"],
    operation: organizations.listParents,
  }),
);
