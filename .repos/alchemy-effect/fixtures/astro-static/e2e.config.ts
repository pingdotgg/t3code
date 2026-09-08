import * as Astro from "@alchemy.run/frontend-frameworks/astro";
import cloudflare from "@alchemy.run/frontend-frameworks/astro/cloudflare";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

export default Options.make({
  // Target-scoped config carriage: `target.cloudflare` carries the worker
  // config (dev/build) and the miniflare preview config.
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-astro-static",
          bindings: [],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "404-page",
          },
        },
      },
      // ASSETS-ONLY preview: a fully-static Astro build must deploy with no
      // user worker. The harness (CloudflareTarget.serve) detects the
      // module-less BuildOutput, synthesizes the stub script miniflare
      // requires, and forces `has_user_worker: false` itself — the fixture
      // declares only the asset semantics (the built 404.html serves via
      // `not_found_handling: "404-page"`).
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        assets: {
          binding: "ASSETS",
          routerConfig: {
            invoke_user_worker_ahead_of_assets: false,
          },
          assetConfig: {
            html_handling: "auto-trailing-slash",
            not_found_handling: "404-page",
          },
        },
      },
    },
  },
  // Deliberately NO `astro:` overrides — this fixture's Astro configuration
  // lives in its real `astro.config.mjs` (`output: "static"`), which the
  // integration must load and honor (the user-config principle).
  framework: (options) =>
    Astro.layer({
      target: cloudflare({ worker: Options.resolveCloudflareOptions(options).worker }),
    }),
});
