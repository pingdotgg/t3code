import { DurableObjectNamespace, Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import wakuFramework from "@alchemy.run/frontend-frameworks/waku";

export const FIXTURE_MESSAGE = "hello-from-waku-do-binding";

/**
 * A waku app plus the user's own Durable Object hosted on the SAME worker.
 * The user's `main` module (src/worker-entry.ts) wraps waku's emitted fetch
 * handler (via `virtual:waku/server-entry`) and additionally exports
 * `class Counter` (a SQLite DO). See README for how the user-entry seam
 * threads through the waku cloudflare target.
 */
export default Options.make({
  target: {
    cloudflare: {
      worker: {
        // The user-entry seam: takes precedence over waku's pinned rsc
        // entry, mirroring Website.Vite's `main` ("Custom Worker Entry"
        // JSDoc in packages/alchemy/src/Cloudflare/Website/Vite.ts). The
        // module wraps waku's server entry and re-exports the Counter DO
        // class.
        main: "./src/worker-entry.ts",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        worker: {
          name: "fixtures-waku-durable-objects",
          bindings: [
            Text.local("MESSAGE", FIXTURE_MESSAGE),
            // Bind the namespace for a DO class exported by THIS worker.
            DurableObjectNamespace.local({ binding: "COUNTER", className: "Counter" }),
          ],
          // The dev runtime's DO declaration (workerd durableObjectNamespaces).
          durableObjectNamespaces: [{ className: "Counter", sql: true }],
          assets: {
            htmlHandling: "drop-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        bindings: { MESSAGE: FIXTURE_MESSAGE },
        // Miniflare's DO declaration for the preview server: binding name ->
        // class exported by the built worker bundle.
        durableObjects: { COUNTER: { className: "Counter", useSQLite: true } },
        assets: {
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "drop-trailing-slash",
            not_found_handling: "none",
            has_static_routing: false,
          },
        },
      },
    },
  },
  framework: (options) => wakuFramework({ ...options, port: 3110 }),
});
