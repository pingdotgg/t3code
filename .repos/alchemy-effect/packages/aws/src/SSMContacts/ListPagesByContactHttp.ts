import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeContactHttpBinding } from "./BindingHttp.ts";
import { ListPagesByContact } from "./ListPagesByContact.ts";

export const ListPagesByContactHttp = Layer.effect(
  ListPagesByContact,
  makeContactHttpBinding({
    tag: "AWS.SSMContacts.ListPagesByContact",
    operation: ssm.listPagesByContact,
    actions: ["ssm-contacts:ListPagesByContact"],
  }),
);
