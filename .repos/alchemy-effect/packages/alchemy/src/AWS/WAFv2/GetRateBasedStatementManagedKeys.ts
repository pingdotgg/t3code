import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WebACL } from "./WebACL.ts";

export interface GetRateBasedStatementManagedKeysRequest extends Omit<
  WAFV2.GetRateBasedStatementManagedKeysRequest,
  "Scope" | "WebACLName" | "WebACLId"
> {}

/**
 * Runtime binding for `wafv2:GetRateBasedStatementManagedKeys` — read the
 * IP addresses that a rate-based rule of the bound {@link WebACL} is
 * currently blocking; the web ACL name, id, and scope are injected
 * automatically.
 *
 * Provide `WAFv2.GetRateBasedStatementManagedKeysHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Inspecting Traffic
 * @example Read the Currently Rate-Limited Addresses
 * ```typescript
 * // init — grants wafv2:GetRateBasedStatementManagedKeys on the web ACL
 * const getManagedKeys = yield* AWS.WAFv2.GetRateBasedStatementManagedKeys(acl);
 *
 * // runtime
 * const { ManagedKeysIPV4 } = yield* getManagedKeys({ RuleName: "rate-limit" });
 * const blocked = ManagedKeysIPV4?.Addresses ?? [];
 * ```
 */
export interface GetRateBasedStatementManagedKeys extends Binding.Service<
  GetRateBasedStatementManagedKeys,
  "AWS.WAFv2.GetRateBasedStatementManagedKeys",
  (
    webAcl: WebACL,
  ) => Effect.Effect<
    (
      request: GetRateBasedStatementManagedKeysRequest,
    ) => Effect.Effect<
      WAFV2.GetRateBasedStatementManagedKeysResponse,
      WAFV2.GetRateBasedStatementManagedKeysError
    >
  >
> {}

export const GetRateBasedStatementManagedKeys =
  Binding.Service<GetRateBasedStatementManagedKeys>(
    "AWS.WAFv2.GetRateBasedStatementManagedKeys",
  );
