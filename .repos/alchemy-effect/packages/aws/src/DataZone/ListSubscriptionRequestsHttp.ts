import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { ListSubscriptionRequests } from "./ListSubscriptionRequests.ts";

export const ListSubscriptionRequestsHttp = Layer.effect(
  ListSubscriptionRequests,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.ListSubscriptionRequests",
    operation: datazone.listSubscriptionRequests,
    actions: ["datazone:ListSubscriptionRequests"],
  }),
);
