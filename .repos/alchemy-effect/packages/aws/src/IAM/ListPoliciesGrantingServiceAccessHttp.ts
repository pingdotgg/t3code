import * as iam from "@distilled.cloud/aws/iam";
import * as Layer from "effect/Layer";
import { makeIamHttpBinding } from "./BindingHttp.ts";
import { ListPoliciesGrantingServiceAccess } from "./ListPoliciesGrantingServiceAccess.ts";

export const ListPoliciesGrantingServiceAccessHttp = Layer.effect(
  ListPoliciesGrantingServiceAccess,
  makeIamHttpBinding({
    capability: "ListPoliciesGrantingServiceAccess",
    iamActions: ["iam:ListPoliciesGrantingServiceAccess"],
    operation: iam.listPoliciesGrantingServiceAccess,
  }),
);
