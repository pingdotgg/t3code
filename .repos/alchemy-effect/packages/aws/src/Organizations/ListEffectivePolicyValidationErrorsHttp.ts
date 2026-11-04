import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListEffectivePolicyValidationErrors } from "./ListEffectivePolicyValidationErrors.ts";

export const ListEffectivePolicyValidationErrorsHttp = Layer.effect(
  ListEffectivePolicyValidationErrors,
  makeOrganizationsHttpBinding({
    capability: "ListEffectivePolicyValidationErrors",
    iamActions: ["organizations:ListEffectivePolicyValidationErrors"],
    operation: organizations.listEffectivePolicyValidationErrors,
  }),
);
