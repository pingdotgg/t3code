import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { ListTopics } from "./ListTopics.ts";

export const ListTopicsHttp = Layer.effect(
  ListTopics,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.ListTopics",
    operation: sns.listTopics,
    actions: ["sns:ListTopics"],
  }),
);
