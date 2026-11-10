import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeRotationHttpBinding } from "./BindingHttp.ts";
import { ListRotationShifts } from "./ListRotationShifts.ts";

export const ListRotationShiftsHttp = Layer.effect(
  ListRotationShifts,
  makeRotationHttpBinding({
    tag: "AWS.SSMContacts.ListRotationShifts",
    operation: ssm.listRotationShifts,
    actions: ["ssm-contacts:ListRotationShifts"],
  }),
);
