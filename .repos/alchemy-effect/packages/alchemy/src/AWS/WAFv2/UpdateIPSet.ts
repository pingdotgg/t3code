import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { IPSet } from "./IPSet.ts";

export interface UpdateIPSetRequest {
  /**
   * The complete new set of IP addresses and CIDR ranges — WAF replaces
   * the entire list.
   */
  addresses: string[];
  /**
   * New description of the IP set. Omitted — the existing description is
   * kept.
   */
  description?: string;
}

/**
 * Runtime binding for `wafv2:UpdateIPSet` — replace the bound
 * {@link IPSet}'s address list at runtime (the classic dynamic block list:
 * a Lambda appends offending IPs as it detects them). The binding reads the
 * IP set for a fresh `LockToken`, applies the update, and retries
 * optimistic-lock conflicts automatically.
 *
 * Provide `WAFv2.UpdateIPSetHttp` on the hosting Lambda Function to satisfy
 * the requirement.
 * @binding
 * @section Managing IP Sets at Runtime
 * @example Add an Offending IP to the Block List
 * ```typescript
 * // init — grants wafv2:GetIPSet + wafv2:UpdateIPSet on the IP set
 * const getIPSet = yield* AWS.WAFv2.GetIPSet(blockList);
 * const updateIPSet = yield* AWS.WAFv2.UpdateIPSet(blockList);
 *
 * // runtime
 * const current = (yield* getIPSet()).IPSet?.Addresses ?? [];
 * yield* updateIPSet({ addresses: [...current, "192.0.2.7/32"] });
 * ```
 */
export interface UpdateIPSet extends Binding.Service<
  UpdateIPSet,
  "AWS.WAFv2.UpdateIPSet",
  (
    ipSet: IPSet,
  ) => Effect.Effect<
    (
      request: UpdateIPSetRequest,
    ) => Effect.Effect<
      WAFV2.UpdateIPSetResponse,
      WAFV2.GetIPSetError | WAFV2.UpdateIPSetError
    >
  >
> {}

export const UpdateIPSet = Binding.Service<UpdateIPSet>(
  "AWS.WAFv2.UpdateIPSet",
);
