import type * as pipes from "@distilled.cloud/aws/pipes";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `pipes:ListPipes`.
 *
 * Lists the account's pipes, optionally filtered by name prefix, current
 * state, or source/target prefix — e.g. an operational console enumerating
 * the pipes it manages. Account-level: no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Pipes.ListPipesHttp)`.
 * @binding
 * @section Observing a Pipe
 * @example List Pipes by Name Prefix
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPipes = yield* AWS.Pipes.ListPipes();
 *
 * // runtime
 * const { Pipes } = yield* listPipes({ NamePrefix: "orders-" });
 * // [{ Name: "orders-pipe", CurrentState: "RUNNING", ... }, ...]
 * ```
 */
export interface ListPipes extends Binding.Service<
  ListPipes,
  "AWS.Pipes.ListPipes",
  () => Effect.Effect<
    (
      request?: pipes.ListPipesRequest,
    ) => Effect.Effect<pipes.ListPipesResponse, pipes.ListPipesError>
  >
> {}
export const ListPipes = Binding.Service<ListPipes>("AWS.Pipes.ListPipes");
