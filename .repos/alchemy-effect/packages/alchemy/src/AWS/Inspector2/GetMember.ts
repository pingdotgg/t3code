import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetMember`.
 *
 * Gets member information for your organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetMemberHttp)`.
 * @binding
 * @section Organization & Members
 * @example Get a Member Account
 * ```typescript
 * // init
 * const getMember = yield* AWS.Inspector2.GetMember();
 *
 * // runtime
 * const { member } = yield* getMember({ accountId });
 * ```
 */
export interface GetMember extends Binding.Service<
  GetMember,
  "AWS.Inspector2.GetMember",
  () => Effect.Effect<
    (
      request: inspector2.GetMemberRequest,
    ) => Effect.Effect<inspector2.GetMemberResponse, inspector2.GetMemberError>
  >
> {}
export const GetMember = Binding.Service<GetMember>("AWS.Inspector2.GetMember");
