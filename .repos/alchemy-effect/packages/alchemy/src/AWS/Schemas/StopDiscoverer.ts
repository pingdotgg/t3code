import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Discoverer } from "./Discoverer.ts";

/**
 * Runtime binding for `schemas:StopDiscoverer`.
 *
 * Pauses schema discovery on the bound {@link Discoverer} — e.g. an ops
 * function halting discovery during a noisy backfill so junk schemas are not
 * published to the `discovered-schemas` registry. The discoverer id is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Schemas.StopDiscovererHttp)`.
 * @binding
 * @section Controlling a Discoverer
 * @example Pause Discovery
 * ```typescript
 * // init — bind the operation to the discoverer
 * const stopDiscoverer = yield* AWS.Schemas.StopDiscoverer(discoverer);
 *
 * // runtime
 * const { State } = yield* stopDiscoverer();
 * // State === "STOPPED"
 * ```
 */
export interface StopDiscoverer extends Binding.Service<
  StopDiscoverer,
  "AWS.Schemas.StopDiscoverer",
  (
    discoverer: Discoverer,
  ) => Effect.Effect<
    () => Effect.Effect<
      schemas.StopDiscovererResponse,
      schemas.StopDiscovererError
    >
  >
> {}
export const StopDiscoverer = Binding.Service<StopDiscoverer>(
  "AWS.Schemas.StopDiscoverer",
);
