import { KvNamespace } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import { kCurrentWorker } from "miniflare";

/**
 * The writable-ISR configuration: KV-backed incremental cache
 * (`NEXT_INC_CACHE_KV`) + Durable Object revalidation queue
 * (`NEXT_CACHE_DO_QUEUE` on the same-script `DOQueueHandler` class) +
 * the `WORKER_SELF_REFERENCE` self service binding.
 *
 * The dev (workerd) runtime auto-wires the DO queue and self-reference:
 * `@alchemy.run/frontend-frameworks/nextjs` detects the `DOQueueHandler` export in the
 * built worker. The preview (miniflare) config declares them explicitly.
 */
export default Options.make({
  framework: "@alchemy.run/frontend-frameworks/nextjs",
  vite: {
    compatibilityDate: "2026-05-12",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    worker: {
      name: "fixtures-nextjs-isr",
      bindings: [
        KvNamespace.local({ binding: "NEXT_INC_CACHE_KV" }),
        KvNamespace.local({ binding: "NEXT_TAG_CACHE_KV" }),
      ],
    },
  },
  miniflare: {
    name: "fixtures-nextjs-isr",
    compatibilityDate: "2026-05-12",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    kvNamespaces: ["NEXT_INC_CACHE_KV", "NEXT_TAG_CACHE_KV"],
    serviceBindings: { WORKER_SELF_REFERENCE: kCurrentWorker },
    durableObjects: {
      NEXT_CACHE_DO_QUEUE: { className: "DOQueueHandler", useSQLite: true },
    },
    assets: {
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: true,
      },
      assetConfig: {
        html_handling: "none",
        not_found_handling: "none",
      },
    },
  },
});
