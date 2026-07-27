import type * as iot from "@distilled.cloud/aws/iot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Thing } from "./Thing.ts";

export interface DescribeThingRequest extends Omit<
  iot.DescribeThingRequest,
  "thingName"
> {}

/**
 * Runtime binding for the `DescribeThing` operation (IAM action
 * `iot:DescribeThing`).
 *
 * Bind it to a {@link Thing} to read the thing's registry entry (attributes,
 * thing type, version) at runtime — the thing name is injected
 * automatically. Provide the implementation with
 * `Effect.provide(AWS.IoT.DescribeThingHttp)`.
 * @binding
 * @section Registry
 * @example Read Thing Attributes
 * ```typescript
 * const describeThing = yield* AWS.IoT.DescribeThing(thing);
 *
 * const { attributes } = yield* describeThing();
 * ```
 */
export interface DescribeThing extends Binding.Service<
  DescribeThing,
  "AWS.IoT.DescribeThing",
  (
    thing: Thing,
  ) => Effect.Effect<
    (
      request?: DescribeThingRequest,
    ) => Effect.Effect<iot.DescribeThingResponse, iot.DescribeThingError>
  >
> {}

export const DescribeThing = Binding.Service<DescribeThing>(
  "AWS.IoT.DescribeThing",
);
