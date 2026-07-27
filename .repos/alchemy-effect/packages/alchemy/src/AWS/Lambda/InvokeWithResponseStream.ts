import type * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Function } from "./Function.ts";

export interface InvokeWithResponseStreamRequest extends Omit<
  Lambda.InvokeWithResponseStreamRequest,
  "FunctionName"
> {}

/**
 * Runtime binding for `lambda:InvokeFunction` over the response-streaming
 * API. Invokes the bound {@link Function} and returns the streaming
 * response — `EventStream` yields `PayloadChunk` events followed by a final
 * `InvokeComplete` event.
 *
 * Provide the `InvokeWithResponseStreamHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Invoking Functions
 * @example Stream a function's response
 * ```typescript
 * const invokeStream = yield* AWS.Lambda.InvokeWithResponseStream(target);
 *
 * const response = yield* invokeStream({
 *   Payload: new TextEncoder().encode(JSON.stringify({ prompt: "hi" })),
 * });
 * const chunks = yield* Stream.runCollect(response.EventStream!);
 * ```
 */
export interface InvokeWithResponseStream extends Binding.Service<
  InvokeWithResponseStream,
  "AWS.Lambda.InvokeWithResponseStream",
  (
    func: Function,
  ) => Effect.Effect<
    (
      request?: InvokeWithResponseStreamRequest,
    ) => Effect.Effect<
      Lambda.InvokeWithResponseStreamResponse,
      Lambda.InvokeWithResponseStreamError
    >
  >
> {}
export const InvokeWithResponseStream =
  Binding.Service<InvokeWithResponseStream>(
    "AWS.Lambda.InvokeWithResponseStream",
  );
