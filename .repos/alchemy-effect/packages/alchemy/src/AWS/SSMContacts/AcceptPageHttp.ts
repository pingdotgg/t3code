import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { AcceptPage } from "./AcceptPage.ts";

export const AcceptPageHttp = Layer.effect(
  AcceptPage,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.AcceptPage",
    operation: ssm.acceptPage,
    actions: ["ssm-contacts:AcceptPage"],
  }),
);
