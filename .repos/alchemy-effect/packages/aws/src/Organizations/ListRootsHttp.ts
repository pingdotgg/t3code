import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListRoots } from "./ListRoots.ts";

export const ListRootsHttp = Layer.effect(
  ListRoots,
  makeOrganizationsHttpBinding({
    capability: "ListRoots",
    iamActions: ["organizations:ListRoots"],
    operation: organizations.listRoots,
  }),
);
