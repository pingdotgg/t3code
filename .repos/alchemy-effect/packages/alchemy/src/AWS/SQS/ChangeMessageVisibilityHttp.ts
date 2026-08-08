import * as sqs from "@distilled.cloud/aws/sqs";
import * as Layer from "effect/Layer";
import { makeQueueUrlHttpBinding } from "./BindingHttp.ts";
import { ChangeMessageVisibility } from "./ChangeMessageVisibility.ts";

export const ChangeMessageVisibilityHttp = Layer.effect(
  ChangeMessageVisibility,
  makeQueueUrlHttpBinding({
    tag: "AWS.SQS.ChangeMessageVisibility",
    operation: sqs.changeMessageVisibility,
    actions: ["sqs:ChangeMessageVisibility"],
  }),
);
