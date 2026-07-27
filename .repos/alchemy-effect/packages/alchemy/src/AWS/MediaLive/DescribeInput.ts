import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "./Input.ts";

/**
 * Runtime binding for `medialive:DescribeInput`.
 *
 * Reads the bound {@link Input}'s live state — attachment state
 * (`DETACHED`/`ATTACHED`), resolved push ingest URLs, sources, and
 * security groups — e.g. so a stream-key service can hand a contributor
 * the RTMP endpoint to push to. The input id is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.MediaLive.DescribeInputHttp)`.
 * @binding
 * @section Observing Inputs
 * @example Read the Input's Ingest Endpoints
 * ```typescript
 * // init — bind the operation to the input
 * const describeInput = yield* AWS.MediaLive.DescribeInput(input);
 *
 * // runtime
 * const { Destinations } = yield* describeInput();
 * const ingestUrl = Destinations?.[0]?.Url;
 * ```
 */
export interface DescribeInput extends Binding.Service<
  DescribeInput,
  "AWS.MediaLive.DescribeInput",
  (
    input: Input,
  ) => Effect.Effect<
    () => Effect.Effect<
      medialive.DescribeInputResponse,
      medialive.DescribeInputError
    >
  >
> {}
export const DescribeInput = Binding.Service<DescribeInput>(
  "AWS.MediaLive.DescribeInput",
);
