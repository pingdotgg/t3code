import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListPendingInvitationResources } from "./ListPendingInvitationResources.ts";

export const ListPendingInvitationResourcesHttp = Layer.effect(
  ListPendingInvitationResources,
  makeRAMHttpBinding({
    capability: "ListPendingInvitationResources",
    iamActions: ["ram:ListPendingInvitationResources"],
    operation: ram.listPendingInvitationResources,
  }),
);
