import { Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import wakuFramework from "@alchemy.run/frontend-frameworks/waku";

// Target-scoped config carriage: `target.cloudflare.worker` is the cloudflare
// deploy target's configuration (read by @alchemy.run/frontend-frameworks/waku via
// `options.target?.cloudflare?.worker ?? options.vite`) and
// `target.cloudflare.preview` configures the miniflare preview server.
export default Options.make({
  target: {
    cloudflare: {
      worker: {
        // `main` and `viteEnvironments` are pinned by @alchemy.run/frontend-frameworks/waku's
        // cloudflare target (waku's rsc entry + the rsc/ssr topology) — only
        // worker config here.
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        worker: {
          name: "fixtures-waku",
          bindings: [Text.local("MESSAGE", "hello-from-binding")],
          assets: {
            htmlHandling: "drop-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        bindings: { MESSAGE: "hello-from-binding" },
        assets: {
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: false,
            debug: true,
          },
          assetConfig: {
            html_handling: "drop-trailing-slash",
            not_found_handling: "none",
            debug: true,
            has_static_routing: false,
          },
        },
      },
    },
  },
  // The typed factory form so the fixture can pin its assigned dev port; the
  // string form (`framework: "@alchemy.run/frontend-frameworks/waku"`) is equivalent minus
  // the extra option.
  framework: (options) => wakuFramework({ ...options, port: 3101 }),
});
