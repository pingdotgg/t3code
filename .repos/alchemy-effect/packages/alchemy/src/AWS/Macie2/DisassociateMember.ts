import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:DisassociateMember`.
 *
 * Disassociates an Amazon Macie administrator account from a member account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DisassociateMemberHttp)`.
 * @binding
 * @section Organization & Members
 * @example Disassociate a Member
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disassociateMember = yield* AWS.Macie2.DisassociateMember();
 *
 * // runtime
 * yield* disassociateMember({ id: accountId });
 * ```
 */
export interface DisassociateMember extends Binding.Service<
  DisassociateMember,
  "AWS.Macie2.DisassociateMember",
  () => Effect.Effect<
    (
      request: macie2.DisassociateMemberRequest,
    ) => Effect.Effect<
      macie2.DisassociateMemberResponse,
      macie2.DisassociateMemberError
    >
  >
> {}
export const DisassociateMember = Binding.Service<DisassociateMember>(
  "AWS.Macie2.DisassociateMember",
);
