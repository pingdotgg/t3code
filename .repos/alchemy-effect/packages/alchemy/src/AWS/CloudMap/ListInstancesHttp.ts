import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import { ListInstances } from "./ListInstances.ts";

export const ListInstancesHttp = Layer.effect(
  ListInstances,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.ListInstances",
    operation: SD.listInstances,
    actions: ["servicediscovery:ListInstances"],
  }),
);
