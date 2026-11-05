import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { ListPreviewRotationShifts } from "./ListPreviewRotationShifts.ts";

export const ListPreviewRotationShiftsHttp = Layer.effect(
  ListPreviewRotationShifts,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.ListPreviewRotationShifts",
    operation: ssm.listPreviewRotationShifts,
    actions: ["ssm-contacts:ListPreviewRotationShifts"],
  }),
);
