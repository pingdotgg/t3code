import type * as rbin from "@distilled.cloud/aws/rbin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rbin:ListRules`.
 *
 * Enumerates the Region's Recycle Bin retention rules for a resource type
 * (`EBS_SNAPSHOT`, `EC2_IMAGE`, or `EBS_VOLUME`), optionally filtered by
 * resource tags, exclusion tags, or lock state — so a function can verify
 * that deletion protection is in place before destructive maintenance.
 * `ListRules` is an account-level list action, so the grant is on `*`.
 * Provide the implementation with `Effect.provide(AWS.Rbin.ListRulesHttp)`.
 * @binding
 * @section Listing Retention Rules
 * @example Enumerate the Region's snapshot retention rules
 * ```typescript
 * // init — grants rbin:ListRules on *
 * const listRules = yield* AWS.Rbin.ListRules();
 *
 * // runtime
 * const { Rules } = yield* listRules({ ResourceType: "EBS_SNAPSHOT" });
 * for (const rule of Rules ?? []) {
 *   yield* Effect.log(`${rule.Identifier}: ${rule.Description ?? ""}`);
 * }
 * ```
 */
export interface ListRules extends Binding.Service<
  ListRules,
  "AWS.Rbin.ListRules",
  () => Effect.Effect<
    (
      request: rbin.ListRulesRequest,
    ) => Effect.Effect<rbin.ListRulesResponse, rbin.ListRulesError>
  >
> {}
export const ListRules = Binding.Service<ListRules>("AWS.Rbin.ListRules");
