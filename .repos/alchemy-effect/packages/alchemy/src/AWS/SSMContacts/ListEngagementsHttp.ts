import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { ListEngagements } from "./ListEngagements.ts";

export const ListEngagementsHttp = Layer.effect(
  ListEngagements,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.ListEngagements",
    operation: ssm.listEngagements,
    actions: ["ssm-contacts:ListEngagements"],
  }),
);
