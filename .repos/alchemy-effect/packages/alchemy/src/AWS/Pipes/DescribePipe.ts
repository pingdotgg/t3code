import type * as pipes from "@distilled.cloud/aws/pipes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipe } from "./Pipe.ts";

/**
 * Runtime binding for `pipes:DescribePipe`.
 *
 * Reads the bound {@link Pipe}'s full definition and live state
 * (`CurrentState`, `DesiredState`, source/enrichment/target parameters) —
 * e.g. an operational dashboard or a controller that checks whether the
 * pipe settled after a start/stop. The pipe name is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Pipes.DescribePipeHttp)`.
 * @binding
 * @section Observing a Pipe
 * @example Read the Pipe's Live State
 * ```typescript
 * // init — bind the operation to the pipe
 * const describePipe = yield* AWS.Pipes.DescribePipe(pipe);
 *
 * // runtime
 * const described = yield* describePipe();
 * // described.CurrentState === "RUNNING"
 * ```
 */
export interface DescribePipe extends Binding.Service<
  DescribePipe,
  "AWS.Pipes.DescribePipe",
  (
    pipe: Pipe,
  ) => Effect.Effect<
    () => Effect.Effect<pipes.DescribePipeResponse, pipes.DescribePipeError>
  >
> {}
export const DescribePipe = Binding.Service<DescribePipe>(
  "AWS.Pipes.DescribePipe",
);
