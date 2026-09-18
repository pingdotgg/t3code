import { UpdateFileLink as updateFileLinkOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";
import { UpdateFileLink } from "./UpdateFileLink.ts";

/**
 * HTTP implementation of {@link UpdateFileLink}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.UpdateFileLink
 */
export const UpdateFileLinkHttp = Layer.effect(
  UpdateFileLink,
  makeHttpStripeIdBinding({
    tag: "Stripe.UpdateFileLink",
    operation: updateFileLinkOp,
    idField: "link",
    permissions: ["files_write"],
  }),
);
