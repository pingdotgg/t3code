import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListTargetsForPolicy } from "./ListTargetsForPolicy.ts";

export const ListTargetsForPolicyHttp = Layer.effect(
  ListTargetsForPolicy,
  makeOrganizationsHttpBinding({
    capability: "ListTargetsForPolicy",
    iamActions: ["organizations:ListTargetsForPolicy"],
    operation: organizations.listTargetsForPolicy,
  }),
);
