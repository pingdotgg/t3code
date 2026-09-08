import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

/**
 * A minimal Vite app with BOTH a client side (index.html + a counter whose
 * marker string comes from an imported module) and a Worker (`main`, an
 * `/api/marker` route whose marker string comes from an imported module).
 *
 * The point of this fixture is the dev-mode edit-propagation specs in
 * test/smoke.test.ts: a client-module edit must arrive as a HOT update
 * (counter state preserved — no full reload), and a worker-module edit must
 * be reflected by the workerd-hosted Worker on a subsequent request.
 */
export default Options.make({
  target: {
    cloudflare: {
      worker: {
        // Worker entry, relative to the Vite root (the fixture root).
        main: "./src/server.ts",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-vite-hmr",
          bindings: [],
          // Assets-aware dev routing: `/` resolves index.html through the
          // vite-aware asset worker (`transformIndexHtml`, HMR client
          // injected); `/api/*` has no asset and invokes the user Worker.
          // `runWorkerFirst` deliberately omitted: the wrangler-matching
          // default is assets first, so `/` resolves index.html through the
          // vite-aware asset worker and `/api/*` falls through to the Worker.
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      // Preview (the Playwright `live` mode): assets first, Worker for
      // everything the asset layer doesn't match — same routing semantics
      // as dev.
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        assets: {
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "auto-trailing-slash",
            not_found_handling: "none",
          },
        },
      },
    },
  },
});
