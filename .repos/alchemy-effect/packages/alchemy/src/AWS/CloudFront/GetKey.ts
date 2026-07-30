import type * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";

export interface GetKeyRequest extends Omit<kvs.GetKeyRequest, "KvsARN"> {}

/**
 * Runtime binding for `cloudfront-keyvaluestore:GetKey`.
 *
 * Reads a single key's value from the bound KeyValueStore's data plane.
 * Values are sensitive — distilled decodes them as `Redacted<string>`;
 * unwrap with `Redacted.value`. Provide the implementation with
 * `Effect.provide(AWS.CloudFront.GetKeyHttp)`.
 * @binding
 * @section Reading KeyValueStore Data
 * @example Read a Key
 * ```typescript
 * // init — bind the operation to the store
 * const getKey = yield* CloudFront.GetKey(store);
 *
 * // runtime
 * const res = yield* getKey({ Key: "routes:/about" });
 * const value = typeof res.Value === "string" ? res.Value : Redacted.value(res.Value);
 * ```
 */
export interface GetKey extends Binding.Service<
  GetKey,
  "AWS.CloudFront.GetKey",
  (
    store: KeyValueStore,
  ) => Effect.Effect<
    (
      request: GetKeyRequest,
    ) => Effect.Effect<kvs.GetKeyResponse, kvs.GetKeyError>
  >
> {}

export const GetKey = Binding.Service<GetKey>("AWS.CloudFront.GetKey");
