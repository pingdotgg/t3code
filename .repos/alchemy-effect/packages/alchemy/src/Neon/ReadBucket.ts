import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  RuntimeStorageMethods,
  StorageBindingOptions,
} from "./StorageBinding.ts";

export interface ReadBucketClient extends RuntimeStorageMethods<
  "get" | "head" | "list"
> {
  /** Presign an object download. This does not make the bucket public. */
  presignGet(
    key: string,
    options?: { expiresIn?: number },
  ): ReturnType<RuntimeStorageMethods<"presign">["presign"]>;
}

/**
 * Read/list storage on a branch. The bucket name limits this client's surface,
 * not credential authorization. Injected Function credentials remain available
 * to the entire process; this is not a Function-level security sandbox.
 *
 * ### Read Objects
 * **Example:** Bind a bucket in Function initialization
 * ```typescript
 * const files = yield* Neon.ReadBucket(uploads);
 * const object = yield* files.get("welcome.txt");
 * ```
 *
 * @binding
 * @product Bucket
 */
export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Neon.ReadBucket",
  (
    bucket: Bucket,
    options?: StorageBindingOptions,
  ) => Effect.Effect<ReadBucketClient>
> {}
export const ReadBucket = Binding.Service<ReadBucket>("Neon.ReadBucket");
