import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListCreateAccountStatus } from "./ListCreateAccountStatus.ts";

export const ListCreateAccountStatusHttp = Layer.effect(
  ListCreateAccountStatus,
  makeOrganizationsHttpBinding({
    capability: "ListCreateAccountStatus",
    iamActions: ["organizations:ListCreateAccountStatus"],
    operation: organizations.listCreateAccountStatus,
  }),
);
