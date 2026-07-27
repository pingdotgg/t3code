import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetMember`.
 *
 * Retrieves information about an account that's associated with an Amazon Macie administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetMemberHttp)`.
 * @binding
 * @section Organization & Members
 * @example Read a Member's Status
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getMember = yield* AWS.Macie2.GetMember();
 *
 * // runtime
 * const { relationshipStatus } = yield* getMember({ id: accountId });
 * ```
 */
export interface GetMember extends Binding.Service<
  GetMember,
  "AWS.Macie2.GetMember",
  () => Effect.Effect<
    (
      request: macie2.GetMemberRequest,
    ) => Effect.Effect<macie2.GetMemberResponse, macie2.GetMemberError>
  >
> {}
export const GetMember = Binding.Service<GetMember>("AWS.Macie2.GetMember");
