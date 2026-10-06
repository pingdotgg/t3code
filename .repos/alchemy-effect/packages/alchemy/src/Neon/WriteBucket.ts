import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  RuntimeStorageMethods,
  StorageBindingOptions,
} from "./StorageBinding.ts";

export interface WriteBucketClient extends RuntimeStorageMethods<
  | "put"
  | "delete"
  | "deleteMany"
  | "createMultipartUpload"
  | "uploadPart"
  | "completeMultipartUpload"
  | "abortMultipartUpload"
  | "listMultipartUploads"
  | "listParts"
> {
  /** Presign an upload; the uploader must send the signed content type. */
  presignPut(
    key: string,
    options?: { expiresIn?: number; contentType?: string },
  ): ReturnType<RuntimeStorageMethods<"presign">["presign"]>;
}

/**
 * Mutate a bucket. Managed clients request storage:read and storage:write because
 * the current S3 service requires explicit read scope, despite the documented
 * write-implies-read contract. Credentials reach descendant branches.
 *
 * ### Upload Objects
 * **Example:** Raw bytes without manual credential handling
 * ```typescript
 * const files = yield* Neon.WriteBucket(uploads);
 * yield* files.put("message.txt", "hello", { ContentType: "text/plain" });
 * ```
 *
 * @binding
 * @product Bucket
 */
export interface WriteBucket extends Binding.Service<
  WriteBucket,
  "Neon.WriteBucket",
  (
    bucket: Bucket,
    options?: StorageBindingOptions,
  ) => Effect.Effect<WriteBucketClient>
> {}
export const WriteBucket = Binding.Service<WriteBucket>("Neon.WriteBucket");
