/**
 * vinext data-cache adapter builder for Cloudflare KV.
 *
 * Cloudflare.Website.Vinext injects this adapter automatically. The runtime factory reads `env.VINEXT_KV_CACHE` (Worker
 * binding) and uses the same ISR codec as Redis / S3.
 *
 * `Website.Vinext` provisions the namespace and seeds prerender pairs
 * at deploy. Missing binding (local prerender) makes vinext log and
 * fall back to the in-memory handler.
 */
import { fileURLToPath } from "node:url";
import type { KvAdapterOptions } from "./kv-runtime.ts";

export type { KvAdapterOptions } from "./kv-runtime.ts";

export const DEFAULT_KV_BINDING = "VINEXT_KV_CACHE";

export const kvAdapter = (options?: KvAdapterOptions) => {
  if (options?.binding !== undefined && typeof options.binding !== "string") {
    throw new TypeError("[vinext] kvAdapter({ binding }) must be a string Worker binding name.");
  }
  return {
    adapter: fileURLToPath(new URL("./kv-runtime.js", import.meta.url)),
    options,
  };
};
