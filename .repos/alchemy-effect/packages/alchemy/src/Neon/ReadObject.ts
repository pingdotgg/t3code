import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Object, ObjectDecodeError } from "./Object.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { StorageBindingOptions } from "./StorageBinding.ts";

export type ObjectValue<T> = [T] extends [never] ? Uint8Array : T;
export interface ReadObjectClient<T> {
  /** Decode typed JSON, or return bytes for a raw body/file resource. */
  get(): Effect.Effect<
    ObjectValue<T> | undefined,
    | Effect.Error<ReturnType<ReadBucketClient["get"]>>
    | ObjectDecodeError
    | Error,
    RuntimeContext
  >;
  /** Always read exact bytes, including for JSON resources. */
  bytes(): Effect.Effect<
    Uint8Array | undefined,
    Effect.Error<ReturnType<ReadBucketClient["get"]>> | Error,
    RuntimeContext
  >;
}

/**
 * Bind an object's key and JSON type without repeating either. A TypeScript
 * generic is an application contract, not runtime validation; an optional schema
 * rejects invalid external writes. No object-only credential scope is claimed.
 *
 * ### Typed Reads
 * **Example:** Read the inferred settings shape
 * ```typescript
 * const settings = yield* Neon.ReadObject(settingsObject);
 * const value = yield* settings.get();
 * ```
 *
 * @binding
 * @product Bucket
 */
export interface ReadObject extends Binding.Service<
  ReadObject,
  "Neon.ReadObject",
  <T>(
    object: Object<T>,
    options?: StorageBindingOptions,
  ) => Effect.Effect<ReadObjectClient<T>>
> {
  <T>(
    object: Object<T>,
    options?: StorageBindingOptions,
  ): Effect.Effect<ReadObjectClient<T>, never, ReadObject>;
}
export const ReadObject = Binding.Service<ReadObject>("Neon.ReadObject");
