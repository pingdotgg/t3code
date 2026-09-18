import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import kvNextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/kv-next-tag-cache";

// The production-realistic writable ISR configuration: the incremental
// cache lives in KV (`NEXT_INC_CACHE_KV`) so revalidation WRITES land,
// time-based revalidation runs through the same-worker Durable Object
// queue (`NEXT_CACHE_DO_QUEUE` + `WORKER_SELF_REFERENCE`), and
// `revalidatePath`/`revalidateTag` purge through the KV tag cache
// (`NEXT_TAG_CACHE_KV`).
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: doQueue,
  tagCache: kvNextTagCache,
});
