import * as aiops from "@distilled.cloud/aws/aiops";
import * as Layer from "effect/Layer";
import { makeAIOpsGroupHttpBinding } from "./BindingHttp.ts";
import { ListTagsForResource } from "./ListTagsForResource.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeAIOpsGroupHttpBinding({
    tag: "AWS.AIOps.ListTagsForResource",
    operation: aiops.listTagsForResource,
    actions: ["aiops:ListTagsForResource"],
    input: (resourceArn) => ({ resourceArn }),
  }),
);
