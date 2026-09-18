import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

export default Options.make({
  vite: {
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_als"],
    worker: {
      name: "fixtures-solid-spa",
      bindings: [],
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "single-page-application",
      },
    },
  },
  miniflare: {
    modules: [
      {
        type: "ESModule",
        path: "index.js",
        contents: `export default { fetch: (request) => new Response("Not Found", { status: 404 }) }`,
      },
    ],
    assets: {
      routerConfig: {
        has_user_worker: false,
        invoke_user_worker_ahead_of_assets: false,
        debug: true,
      },
      assetConfig: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "single-page-application",
        debug: true,
        has_static_routing: false,
      },
    },
  },
});
