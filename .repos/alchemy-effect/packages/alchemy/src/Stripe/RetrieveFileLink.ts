import type {
  FileLink as StripeFileLink,
  GetFileLinkError,
  GetFileLinkRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { FileLink } from "./FileLink.ts";

export interface RetrieveFileLinkRequest extends Omit<
  GetFileLinkRequest,
  "link"
> {}

/**
 * Retrieve a bound Stripe File Link over HTTP.
 *
 * ### Reading a File Link
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveFileLink(link);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveFileLink extends Binding.Service<
  RetrieveFileLink,
  "Stripe.RetrieveFileLink",
  (
    fileLink: FileLink,
  ) => Effect.Effect<
    (
      request?: RetrieveFileLinkRequest,
    ) => Effect.Effect<StripeFileLink, GetFileLinkError, RuntimeContext>
  >
> {}

export const RetrieveFileLink = Binding.Service<RetrieveFileLink>(
  "Stripe.RetrieveFileLink",
);
