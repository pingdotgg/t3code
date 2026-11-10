import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import vocsFramework from "@alchemy.run/frontend-frameworks/vocs";
import cloudflare from "@alchemy.run/frontend-frameworks/vocs/cloudflare";

export default Options.make({
  target: {
    cloudflare: {
      worker: {
        // `main` and `viteEnvironments` are pinned by the waku cloudflare
        // target (waku's rsc entry + the rsc/ssr topology) — only worker
        // config here.
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-vocs",
          bindings: [],
          assets: {
            htmlHandling: "drop-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
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
  framework: (options) =>
    vocsFramework({
      root: options.root,
      port: 3105,
      target: cloudflare({
        worker: Options.resolveCloudflareOptions(options).worker,
      }),
    }),
});
