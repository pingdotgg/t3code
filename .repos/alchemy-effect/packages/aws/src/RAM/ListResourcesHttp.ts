import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListResources } from "./ListResources.ts";

export const ListResourcesHttp = Layer.effect(
  ListResources,
  makeRAMHttpBinding({
    capability: "ListResources",
    iamActions: ["ram:ListResources"],
    operation: ram.listResources,
  }),
);
