import * as shield from "@distilled.cloud/aws/shield";
import * as Layer from "effect/Layer";
import { makeShieldHttpBinding } from "./BindingHttp.ts";
import { ListResourcesInProtectionGroup } from "./ListResourcesInProtectionGroup.ts";

export const ListResourcesInProtectionGroupHttp = Layer.effect(
  ListResourcesInProtectionGroup,
  makeShieldHttpBinding({
    tag: "AWS.Shield.ListResourcesInProtectionGroup",
    operation: shield.listResourcesInProtectionGroup,
    actions: ["shield:ListResourcesInProtectionGroup"],
  }),
);
