import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

export default Options.make({
  vite: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    exports: ["default"],
    worker: {
      name: "fixtures-solidstart",
      bindings: [],
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "none",
      },
    },
  },
  miniflare: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: false,
        debug: true,
      },
      assetConfig: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "none",
        debug: true,
        has_static_routing: false,
      },
    },
  },
});
