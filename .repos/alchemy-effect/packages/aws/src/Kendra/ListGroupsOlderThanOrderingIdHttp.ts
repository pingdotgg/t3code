import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { ListGroupsOlderThanOrderingId } from "./ListGroupsOlderThanOrderingId.ts";

export const ListGroupsOlderThanOrderingIdHttp = Layer.effect(
  ListGroupsOlderThanOrderingId,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.ListGroupsOlderThanOrderingId",
    operation: kendra.listGroupsOlderThanOrderingId,
    actions: ["kendra:ListGroupsOlderThanOrderingId"],
    subResources: ["data-source/*"],
  }),
);
