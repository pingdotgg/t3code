import { Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import * as SvelteKit from "@alchemy.run/frontend-frameworks/sveltekit";

// Read by the /api/widgets endpoint via `platform.env` — the point of this
// fixture: even with `ssr = false` (pure SPA), +server.ts endpoints still run
// server-side in the worker, with real bindings.
export const FIXTURE_MESSAGE = "hello-from-sveltekit-spa-binding";

export default Options.make({
  // Typed factory form: map harness options onto SvelteKit options, then pin
  // the dev port so parallel fixture runs don't collide.
  framework: (options) => {
    const base = SvelteKit.fromHarnessOptions(options as SvelteKit.HarnessOptions);
    return SvelteKit.layer({
      ...base,
      dev: { ...base.dev, port: 3108 },
    });
  },
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-sveltekit-spa",
          bindings: [Text.local("FIXTURE_MESSAGE", FIXTURE_MESSAGE)],
          assets: {
            htmlHandling: "auto-trailing-slash",
            // The SPA mode under test: drives the adapter's fallback-page
            // generation (`builder.generateFallback` -> index.html) and must
            // flow through to the deployed assets' not_found_handling.
            notFoundHandling: "single-page-application",
            runWorkerFirst: false,
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { FIXTURE_MESSAGE },
        assets: {
          binding: "ASSETS",
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "auto-trailing-slash",
            // The preview must honor the SPA fallback the adapter emitted:
            // unmatched paths serve the generated index.html app shell.
            not_found_handling: "single-page-application",
          },
        },
      },
    },
  },
});
