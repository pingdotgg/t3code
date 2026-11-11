import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";
import { PutGroup } from "./PutGroup.ts";

export const PutGroupHttp = Layer.effect(
  PutGroup,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.PutGroup",
    operation: qbusiness.putGroup,
    actions: ["qbusiness:PutGroup"],
    subResources: ["data-source/*"],
  }),
);
