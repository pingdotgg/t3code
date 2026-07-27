import type * as synthetics from "@distilled.cloud/aws/synthetics";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Canary } from "./Canary.ts";

/**
 * Runtime binding for `synthetics:StartCanary` — start the bound
 * {@link Canary} running on its configured schedule (e.g. trigger an
 * on-demand smoke test after a deployment); the canary name is injected
 * automatically.
 *
 * Provide `Synthetics.StartCanaryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Controlling the Canary
 * @example Start the Canary
 * ```typescript
 * // init — grants synthetics:StartCanary on the canary
 * const startCanary = yield* AWS.Synthetics.StartCanary(canary);
 *
 * // runtime — a ConflictException means it is already starting/running
 * yield* startCanary().pipe(
 *   Effect.catchTag("ConflictException", () => Effect.void),
 * );
 * ```
 */
export interface StartCanary extends Binding.Service<
  StartCanary,
  "AWS.Synthetics.StartCanary",
  (
    canary: Canary,
  ) => Effect.Effect<
    () => Effect.Effect<
      synthetics.StartCanaryResponse,
      synthetics.StartCanaryError
    >
  >
> {}

export const StartCanary = Binding.Service<StartCanary>(
  "AWS.Synthetics.StartCanary",
);
