import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListResourceTypes } from "./ListResourceTypes.ts";

export const ListResourceTypesHttp = Layer.effect(
  ListResourceTypes,
  makeRAMHttpBinding({
    capability: "ListResourceTypes",
    iamActions: ["ram:ListResourceTypes"],
    operation: ram.listResourceTypes,
  }),
);
