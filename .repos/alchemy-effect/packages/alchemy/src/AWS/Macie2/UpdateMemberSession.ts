import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateMemberSession`.
 *
 * Enables an Amazon Macie administrator to suspend or re-enable Macie for a member account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateMemberSessionHttp)`.
 * @binding
 * @section Organization & Members
 * @example Pause Macie for a Member
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateMemberSession = yield* AWS.Macie2.UpdateMemberSession();
 *
 * // runtime
 * yield* updateMemberSession({ id: accountId, status: "PAUSED" });
 * ```
 */
export interface UpdateMemberSession extends Binding.Service<
  UpdateMemberSession,
  "AWS.Macie2.UpdateMemberSession",
  () => Effect.Effect<
    (
      request: macie2.UpdateMemberSessionRequest,
    ) => Effect.Effect<
      macie2.UpdateMemberSessionResponse,
      macie2.UpdateMemberSessionError
    >
  >
> {}
export const UpdateMemberSession = Binding.Service<UpdateMemberSession>(
  "AWS.Macie2.UpdateMemberSession",
);
