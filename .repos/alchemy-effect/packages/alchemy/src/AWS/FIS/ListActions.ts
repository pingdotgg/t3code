import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:ListActions`.
 *
 * Enumerates the FIS action catalog — every fault the service can inject
 * (`aws:ec2:stop-instances`, `aws:ssm:send-command`, `aws:fis:wait`, …).
 * Provide the implementation with `Effect.provide(AWS.FIS.ListActionsHttp)`.
 * ### Browsing the Action Catalog
 * **Example:** List Available Fault Actions
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listActions = yield* AWS.FIS.ListActions();
 *
 * // runtime
 * const { actions } = yield* listActions();
 * console.log((actions ?? []).map((a) => a.id));
 * ```
 *
 * @binding
 */
export interface ListActions extends Binding.Service<
  ListActions,
  "AWS.FIS.ListActions",
  () => Effect.Effect<
    (
      request?: fis.ListActionsRequest,
    ) => Effect.Effect<fis.ListActionsResponse, fis.ListActionsError>
  >
> {}
export const ListActions = Binding.Service<ListActions>("AWS.FIS.ListActions");
