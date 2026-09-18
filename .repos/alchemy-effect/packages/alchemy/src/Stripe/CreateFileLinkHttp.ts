import { CreateFileLink as createFileLinkOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateFileLink } from "./CreateFileLink.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateFileLink}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateFileLink
 */
export const CreateFileLinkHttp = Layer.effect(
  CreateFileLink,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateFileLink",
    operation: createFileLinkOp,
    permissions: ["files_write"],
  }),
);
