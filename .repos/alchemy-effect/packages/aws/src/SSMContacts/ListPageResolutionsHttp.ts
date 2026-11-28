import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { ListPageResolutions } from "./ListPageResolutions.ts";

export const ListPageResolutionsHttp = Layer.effect(
  ListPageResolutions,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.ListPageResolutions",
    operation: ssm.listPageResolutions,
    actions: ["ssm-contacts:ListPageResolutions"],
  }),
);
