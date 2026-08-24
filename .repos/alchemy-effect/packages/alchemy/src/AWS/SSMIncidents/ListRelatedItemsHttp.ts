import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";
import { ListRelatedItems } from "./ListRelatedItems.ts";

export const ListRelatedItemsHttp = Layer.effect(
  ListRelatedItems,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.ListRelatedItems",
    operation: incidents.listRelatedItems,
    actions: ["ssm-incidents:ListRelatedItems"],
  }),
);
