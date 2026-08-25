import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { ListTargetResourceTypes } from "./ListTargetResourceTypes.ts";

export const ListTargetResourceTypesHttp = Layer.effect(
  ListTargetResourceTypes,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.ListTargetResourceTypes",
    operation: fis.listTargetResourceTypes,
    actions: ["fis:ListTargetResourceTypes"],
  }),
);
