import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

export default defineCloudflareConfig({
  // Read-only incremental cache backed by the ASSETS binding — no KV/R2/D1
  // required. ISR pages serve their prerendered payloads; revalidation
  // writes are no-ops (documented v1 limitation of Website.Nextjs).
  incrementalCache: staticAssetsIncrementalCache,
});
