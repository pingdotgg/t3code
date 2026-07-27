import type * as pipes from "@distilled.cloud/aws/pipes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipe } from "./Pipe.ts";

/**
 * Runtime binding for `pipes:StartPipe`.
 *
 * Starts the bound {@link Pipe} after it was stopped — e.g. resuming
 * source polling on a schedule or in response to an operational signal.
 * The response reports the transitional `STARTING`/desired `RUNNING`
 * states; use {@link DescribePipe} to observe when the pipe settles. The
 * pipe name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Pipes.StartPipeHttp)`.
 * @binding
 * @section Controlling a Pipe
 * @example Resume a Stopped Pipe
 * ```typescript
 * // init — bind the operation to the pipe
 * const startPipe = yield* AWS.Pipes.StartPipe(pipe);
 *
 * // runtime
 * const response = yield* startPipe();
 * // response.DesiredState === "RUNNING"
 * ```
 */
export interface StartPipe extends Binding.Service<
  StartPipe,
  "AWS.Pipes.StartPipe",
  (
    pipe: Pipe,
  ) => Effect.Effect<
    () => Effect.Effect<pipes.StartPipeResponse, pipes.StartPipeError>
  >
> {}
export const StartPipe = Binding.Service<StartPipe>("AWS.Pipes.StartPipe");
