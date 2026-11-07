import type {
  FileLink as StripeFileLink,
  CreateFileLinkError,
  CreateFileLinkRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Create a Stripe File Link over HTTP. Account-scoped — binds the API key
 * onto the host, not a specific file link resource.
 *
 * ### Creating a File Link at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateFileLink();
 * const link = yield* create({
 *   file: "file_123",
 * });
 * ```
 *
 * @binding
 * @product Files
 */
export interface CreateFileLink extends Binding.Service<
  CreateFileLink,
  "Stripe.CreateFileLink",
  () => Effect.Effect<
    (
      request: CreateFileLinkRequest,
    ) => Effect.Effect<StripeFileLink, CreateFileLinkError, RuntimeContext>
  >
> {}

export const CreateFileLink = Binding.Service<CreateFileLink>("Stripe.CreateFileLink");
