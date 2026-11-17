import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListAWSServiceAccessForOrganization } from "./ListAWSServiceAccessForOrganization.ts";

export const ListAWSServiceAccessForOrganizationHttp = Layer.effect(
  ListAWSServiceAccessForOrganization,
  makeOrganizationsHttpBinding({
    capability: "ListAWSServiceAccessForOrganization",
    iamActions: ["organizations:ListAWSServiceAccessForOrganization"],
    operation: organizations.listAWSServiceAccessForOrganization,
  }),
);
