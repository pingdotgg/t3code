import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:DeleteMember`.
 *
 * Deletes the association between an Amazon Macie administrator account and an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DeleteMemberHttp)`.
 * @binding
 * @section Organization & Members
 * @example Delete a Member Association
 * ```typescript
 * // init — account-level binding, no resource argument
 * const deleteMember = yield* AWS.Macie2.DeleteMember();
 *
 * // runtime
 * yield* deleteMember({ id: accountId });
 * ```
 */
export interface DeleteMember extends Binding.Service<
  DeleteMember,
  "AWS.Macie2.DeleteMember",
  () => Effect.Effect<
    (
      request: macie2.DeleteMemberRequest,
    ) => Effect.Effect<macie2.DeleteMemberResponse, macie2.DeleteMemberError>
  >
> {}
export const DeleteMember = Binding.Service<DeleteMember>(
  "AWS.Macie2.DeleteMember",
);
