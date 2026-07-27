import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  R2Error,
  GetOptions,
  ListOptions,
  R2Object,
  ObjectBody,
  Objects,
} from "./BucketTypes.ts";

/**
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Cloudflare.R2.ReadBucket",
  (bucket: Bucket) => Effect.Effect<ReadBucketClient>
> {}

export const ReadBucket = Binding.Service<ReadBucket>(
  "Cloudflare.R2.ReadBucket",
);

export interface ReadBucketClient {
  raw: Effect.Effect<runtime.R2Bucket, never, RuntimeContext>;
  head(key: string): Effect.Effect<R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options: GetOptions & {
      onlyIf: runtime.R2Conditional | Headers;
    },
  ): Effect.Effect<ObjectBody | R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options?: GetOptions,
  ): Effect.Effect<ObjectBody | null, R2Error, RuntimeContext>;
  list(options?: ListOptions): Effect.Effect<Objects, R2Error, RuntimeContext>;
}
