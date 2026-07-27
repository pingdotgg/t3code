import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { IPSet } from "./IPSet.ts";

/**
 * Runtime binding for `wafv2:GetIPSet` — read the bound {@link IPSet}'s
 * current addresses; the name, scope, and id are injected automatically.
 *
 * Provide `WAFv2.GetIPSetHttp` on the hosting Lambda Function to satisfy
 * the requirement.
 * @binding
 * @section Managing IP Sets at Runtime
 * @example Read the Current Block List
 * ```typescript
 * // init — grants wafv2:GetIPSet on the IP set
 * const getIPSet = yield* AWS.WAFv2.GetIPSet(blockList);
 *
 * // runtime
 * const { IPSet } = yield* getIPSet();
 * const addresses = IPSet?.Addresses ?? [];
 * ```
 */
export interface GetIPSet extends Binding.Service<
  GetIPSet,
  "AWS.WAFv2.GetIPSet",
  (
    ipSet: IPSet,
  ) => Effect.Effect<
    () => Effect.Effect<WAFV2.GetIPSetResponse, WAFV2.GetIPSetError>
  >
> {}

export const GetIPSet = Binding.Service<GetIPSet>("AWS.WAFv2.GetIPSet");
