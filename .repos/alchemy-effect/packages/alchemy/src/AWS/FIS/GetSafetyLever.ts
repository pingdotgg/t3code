import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:GetSafetyLever`.
 *
 * Reads the account's safety lever — the emergency switch that, when
 * `engaged`, stops all running experiments and prevents new ones from
 * starting. The account's lever has the well-known id `default`. Provide the
 * implementation with `Effect.provide(AWS.FIS.GetSafetyLeverHttp)`.
 * @binding
 * @section The Safety Lever
 * @example Check Whether Experiments Are Halted
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSafetyLever = yield* AWS.FIS.GetSafetyLever();
 *
 * // runtime
 * const { safetyLever } = yield* getSafetyLever({ id: "default" });
 * console.log(safetyLever?.state?.status); // "disengaged"
 * ```
 */
export interface GetSafetyLever extends Binding.Service<
  GetSafetyLever,
  "AWS.FIS.GetSafetyLever",
  () => Effect.Effect<
    (
      request: fis.GetSafetyLeverRequest,
    ) => Effect.Effect<fis.GetSafetyLeverResponse, fis.GetSafetyLeverError>
  >
> {}
export const GetSafetyLever = Binding.Service<GetSafetyLever>(
  "AWS.FIS.GetSafetyLever",
);
