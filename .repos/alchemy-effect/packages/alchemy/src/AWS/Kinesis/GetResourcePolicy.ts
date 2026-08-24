import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetResourcePolicyRequest extends Omit<
  Kinesis.GetResourcePolicyInput,
  "ResourceARN"
> {}

/**
 * Runtime binding for `kinesis:GetResourcePolicy`.
 *
 * Bind this operation to a `Stream` to read the resource policy attached to
 * it (set via the stream's `resourcePolicy` prop) — the stream ARN is
 * injected automatically. Provide the implementation with
 * `Effect.provide(AWS.Kinesis.GetResourcePolicyHttp)`.
 * @binding
 * @section Inspecting Streams
 * @example Read the Stream's Resource Policy
 * ```typescript
 * // init
 * const getResourcePolicy = yield* AWS.Kinesis.GetResourcePolicy(stream);
 *
 * // runtime
 * const result = yield* getResourcePolicy();
 * const policy = JSON.parse(result.Policy);
 * ```
 */
export interface GetResourcePolicy extends Binding.Service<
  GetResourcePolicy,
  "AWS.Kinesis.GetResourcePolicy",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: GetResourcePolicyRequest,
    ) => Effect.Effect<
      Kinesis.GetResourcePolicyOutput,
      Kinesis.GetResourcePolicyError
    >
  >
> {}

export const GetResourcePolicy = Binding.Service<GetResourcePolicy>(
  "AWS.Kinesis.GetResourcePolicy",
);
