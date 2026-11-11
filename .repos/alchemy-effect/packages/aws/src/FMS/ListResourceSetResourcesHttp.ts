import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListResourceSetResources } from "./ListResourceSetResources.ts";

export const ListResourceSetResourcesHttp = Layer.effect(
  ListResourceSetResources,
  makeFmsHttpBinding({
    capability: "ListResourceSetResources",
    iamActions: ["fms:ListResourceSetResources"],
    operation: fms.listResourceSetResources,
  }),
);
