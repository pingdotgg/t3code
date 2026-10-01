import type {
  FileLink as StripeFileLink,
  UpdateFileLinkError,
  UpdateFileLinkRequest as DistilledUpdateFileLinkRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { FileLink } from "./FileLink.ts";

export interface UpdateFileLinkRequest extends Omit<
  DistilledUpdateFileLinkRequest,
  "link"
> {}

/**
 * Update a bound Stripe File Link over HTTP. Expired links cannot be
 * updated.
 *
 * ### Updating a File Link
 * **Example:** Bind and expire
 * ```typescript
 * const update = yield* Stripe.UpdateFileLink(link);
 * const live = yield* update({ expires_at: "now" });
 * ```
 *
 * @binding
 */
export interface UpdateFileLink extends Binding.Service<
  UpdateFileLink,
  "Stripe.UpdateFileLink",
  (
    fileLink: FileLink,
  ) => Effect.Effect<
    (
      request?: UpdateFileLinkRequest,
    ) => Effect.Effect<StripeFileLink, UpdateFileLinkError, RuntimeContext>
  >
> {}

export const UpdateFileLink = Binding.Service<UpdateFileLink>(
  "Stripe.UpdateFileLink",
);
