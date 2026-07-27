import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:ListStreamProcessors` — list the stream processors in the account.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:ListStreamProcessors` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.ListStreamProcessorsHttp)`.
 *
 * @binding
 * @section Stream Processors
 * @example List Stream Processors
 * ```typescript
 * // init
 * const listStreamProcessors = yield* AWS.Rekognition.ListStreamProcessors();
 *
 * // runtime
 * const page = yield* listStreamProcessors({ MaxResults: 10 });
 * // page.StreamProcessors
 * ```
 */
export interface ListStreamProcessors extends Binding.Service<
  ListStreamProcessors,
  "AWS.Rekognition.ListStreamProcessors",
  () => Effect.Effect<
    (
      request?: rekognition.ListStreamProcessorsRequest,
    ) => Effect.Effect<
      rekognition.ListStreamProcessorsResponse,
      rekognition.ListStreamProcessorsError
    >
  >
> {}
export const ListStreamProcessors = Binding.Service<ListStreamProcessors>(
  "AWS.Rekognition.ListStreamProcessors",
);
