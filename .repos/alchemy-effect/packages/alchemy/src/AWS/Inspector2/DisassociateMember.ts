import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:DisassociateMember`.
 *
 * Disassociates a member account from an Amazon Inspector delegated administrator.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.DisassociateMemberHttp)`.
 * @binding
 * @section Organization & Members
 * @example Disassociate a Member Account
 * ```typescript
 * // init
 * const disassociateMember = yield* AWS.Inspector2.DisassociateMember();
 *
 * // runtime
 * yield* disassociateMember({ accountId });
 * ```
 */
export interface DisassociateMember extends Binding.Service<
  DisassociateMember,
  "AWS.Inspector2.DisassociateMember",
  () => Effect.Effect<
    (
      request: inspector2.DisassociateMemberRequest,
    ) => Effect.Effect<
      inspector2.DisassociateMemberResponse,
      inspector2.DisassociateMemberError
    >
  >
> {}
export const DisassociateMember = Binding.Service<DisassociateMember>(
  "AWS.Inspector2.DisassociateMember",
);
