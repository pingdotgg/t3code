import type * as pipes from "@distilled.cloud/aws/pipes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipe } from "./Pipe.ts";

/**
 * Runtime binding for `pipes:StopPipe`.
 *
 * Stops the bound {@link Pipe} without deleting it — e.g. pausing source
 * polling during a maintenance window or in response to a poison-pill
 * backlog. The response reports the transitional `STOPPING`/desired
 * `STOPPED` states; use {@link DescribePipe} to observe when the pipe
 * settles. The pipe name is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Pipes.StopPipeHttp)`.
 * @binding
 * @section Controlling a Pipe
 * @example Pause a Running Pipe
 * ```typescript
 * // init — bind the operation to the pipe
 * const stopPipe = yield* AWS.Pipes.StopPipe(pipe);
 *
 * // runtime
 * const response = yield* stopPipe();
 * // response.DesiredState === "STOPPED"
 * ```
 */
export interface StopPipe extends Binding.Service<
  StopPipe,
  "AWS.Pipes.StopPipe",
  (
    pipe: Pipe,
  ) => Effect.Effect<
    () => Effect.Effect<pipes.StopPipeResponse, pipes.StopPipeError>
  >
> {}
export const StopPipe = Binding.Service<StopPipe>("AWS.Pipes.StopPipe");
