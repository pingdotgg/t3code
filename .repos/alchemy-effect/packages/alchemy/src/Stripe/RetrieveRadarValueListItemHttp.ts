import { GetRadarValueListItem } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveRadarValueListItem } from "./RetrieveRadarValueListItem.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveRadarValueListItem}.
 *
 * @layer
 * @provides Stripe.RetrieveRadarValueListItem
 */
export const RetrieveRadarValueListItemHttp = Layer.effect(
  RetrieveRadarValueListItem,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveRadarValueListItem",
    operation: GetRadarValueListItem,
    idField: "item",
    permissions: ["radar_read"],
  }),
);
