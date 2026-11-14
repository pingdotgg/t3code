import type * as Cloudflare from "@cloudflare/workers-types";

export interface ProtocolBindings {
  readonly INDEX: Cloudflare.D1Database;
  readonly ARTIFACTS: Omit<Cloudflare.R2Bucket, "get"> & {
    get(key: string): Promise<
      | (Omit<Cloudflare.R2ObjectBody, "body"> & {
          readonly body: ReadableStream<Uint8Array>;
        })
      | null
    >;
  };
  readonly GC_BATCH_SIZE: string;
}
