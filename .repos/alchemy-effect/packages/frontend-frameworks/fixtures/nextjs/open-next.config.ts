import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue";

export default defineCloudflareConfig({
  // Read-only incremental cache backed by the ASSETS binding — no KV/R2/D1
  // required, so the fixture stays fully local. ISR pages serve their
  // prerendered payloads; revalidation writes are no-ops (a known dev-v1
  // limitation until cloudflare-runtime grows local writable storage).
  incrementalCache: staticAssetsIncrementalCache,
  // Exercises the WORKER_SELF_REFERENCE service binding for revalidation.
  queue: memoryQueue,
});
