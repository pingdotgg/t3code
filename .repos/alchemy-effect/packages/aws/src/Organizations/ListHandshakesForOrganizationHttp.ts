import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListHandshakesForOrganization } from "./ListHandshakesForOrganization.ts";

export const ListHandshakesForOrganizationHttp = Layer.effect(
  ListHandshakesForOrganization,
  makeOrganizationsHttpBinding({
    capability: "ListHandshakesForOrganization",
    iamActions: ["organizations:ListHandshakesForOrganization"],
    operation: organizations.listHandshakesForOrganization,
  }),
);
