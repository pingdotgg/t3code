import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { AcceptPage } from "./AcceptPage.ts";
import { makeAccountHttpBinding } from "./BindingHttp.ts";

export const AcceptPageHttp = Layer.effect(
  AcceptPage,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.AcceptPage",
    operation: ssm.acceptPage,
    actions: ["ssm-contacts:AcceptPage"],
  }),
);
