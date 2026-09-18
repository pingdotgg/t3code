import { GetFileLink } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveFileLink } from "./RetrieveFileLink.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveFileLink}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveFileLink
 */
export const RetrieveFileLinkHttp = Layer.effect(
  RetrieveFileLink,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveFileLink",
    operation: GetFileLink,
    idField: "link",
    permissions: ["files_read"],
  }),
);
