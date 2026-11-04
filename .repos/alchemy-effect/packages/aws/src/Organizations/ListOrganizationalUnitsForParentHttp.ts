import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListOrganizationalUnitsForParent } from "./ListOrganizationalUnitsForParent.ts";

export const ListOrganizationalUnitsForParentHttp = Layer.effect(
  ListOrganizationalUnitsForParent,
  makeOrganizationsHttpBinding({
    capability: "ListOrganizationalUnitsForParent",
    iamActions: ["organizations:ListOrganizationalUnitsForParent"],
    operation: organizations.listOrganizationalUnitsForParent,
  }),
);
