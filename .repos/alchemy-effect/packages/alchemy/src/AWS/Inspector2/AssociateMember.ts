import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:AssociateMember`.
 *
 * Associates an Amazon Web Services account with an Amazon Inspector delegated administrator. An HTTP 200 response
 * indicates the association was successfully started, but doesn’t indicate whether it was
 * completed. You can check if the association completed by using ListMembers for multiple
 * accounts or GetMembers for a single account.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.AssociateMemberHttp)`.
 * @binding
 * @section Organization & Members
 * @example Associate a Member Account
 * ```typescript
 * // init
 * const associateMember = yield* AWS.Inspector2.AssociateMember();
 *
 * // runtime
 * yield* associateMember({ accountId });
 * ```
 */
export interface AssociateMember extends Binding.Service<
  AssociateMember,
  "AWS.Inspector2.AssociateMember",
  () => Effect.Effect<
    (
      request: inspector2.AssociateMemberRequest,
    ) => Effect.Effect<
      inspector2.AssociateMemberResponse,
      inspector2.AssociateMemberError
    >
  >
> {}
export const AssociateMember = Binding.Service<AssociateMember>(
  "AWS.Inspector2.AssociateMember",
);
