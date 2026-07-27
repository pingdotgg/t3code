import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:CreateMember`.
 *
 * Associates an account with an Amazon Macie administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.CreateMemberHttp)`.
 * @binding
 * @section Organization & Members
 * @example Associate a Member Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const createMember = yield* AWS.Macie2.CreateMember();
 *
 * // runtime
 * yield* createMember({ account: { accountId, email } });
 * ```
 */
export interface CreateMember extends Binding.Service<
  CreateMember,
  "AWS.Macie2.CreateMember",
  () => Effect.Effect<
    (
      request?: macie2.CreateMemberRequest,
    ) => Effect.Effect<macie2.CreateMemberResponse, macie2.CreateMemberError>
  >
> {}
export const CreateMember = Binding.Service<CreateMember>(
  "AWS.Macie2.CreateMember",
);
