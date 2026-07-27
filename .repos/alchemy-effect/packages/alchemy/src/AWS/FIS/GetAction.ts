import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:GetAction`.
 *
 * Reads a single FIS action from the service's action catalog — its
 * description, parameters, and the targets it applies to (e.g.
 * `aws:ec2:stop-instances`). Provide the implementation with
 * `Effect.provide(AWS.FIS.GetActionHttp)`.
 * @binding
 * @section Browsing the Action Catalog
 * @example Inspect an Action's Parameters
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAction = yield* AWS.FIS.GetAction();
 *
 * // runtime
 * const { action } = yield* getAction({ id: "aws:fis:wait" });
 * console.log(Object.keys(action?.parameters ?? {}));
 * ```
 */
export interface GetAction extends Binding.Service<
  GetAction,
  "AWS.FIS.GetAction",
  () => Effect.Effect<
    (
      request: fis.GetActionRequest,
    ) => Effect.Effect<fis.GetActionResponse, fis.GetActionError>
  >
> {}
export const GetAction = Binding.Service<GetAction>("AWS.FIS.GetAction");
