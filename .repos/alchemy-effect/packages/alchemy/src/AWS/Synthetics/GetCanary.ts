import type * as synthetics from "@distilled.cloud/aws/synthetics";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Canary } from "./Canary.ts";

export interface GetCanaryRequest extends Omit<
  synthetics.GetCanaryRequest,
  "Name"
> {}

/**
 * Runtime binding for `synthetics:GetCanary` — read the full configuration
 * and current status (state, last run, timeline) of the bound
 * {@link Canary}; the canary name is injected automatically.
 *
 * Provide `Synthetics.GetCanaryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Canary Status
 * @example Read the Canary's Current State
 * ```typescript
 * // init — grants synthetics:GetCanary on the canary
 * const getCanary = yield* AWS.Synthetics.GetCanary(canary);
 *
 * // runtime
 * const { Canary } = yield* getCanary();
 * const state = Canary?.Status?.State;
 * ```
 */
export interface GetCanary extends Binding.Service<
  GetCanary,
  "AWS.Synthetics.GetCanary",
  (
    canary: Canary,
  ) => Effect.Effect<
    (
      request?: GetCanaryRequest,
    ) => Effect.Effect<synthetics.GetCanaryResponse, synthetics.GetCanaryError>
  >
> {}

export const GetCanary = Binding.Service<GetCanary>("AWS.Synthetics.GetCanary");
