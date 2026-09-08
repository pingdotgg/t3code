import * as Astro from "@alchemy.run/frontend-frameworks/astro";
import cloudflare from "@alchemy.run/frontend-frameworks/astro/cloudflare";
import { Assets, Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

export const FIXTURE_VALUE = "hello-from-astro-binding";

export default Options.make({
  // Target-scoped config carriage (the canonical form): `target.cloudflare`
  // carries the worker config (dev/build) and the miniflare preview config.
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-astro",
          bindings: [Assets.local("ASSETS"), Text.local("FIXTURE_VALUE", FIXTURE_VALUE)],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { FIXTURE_VALUE },
        // Zero-config sessions: the built app reads the SESSION KV binding.
        kvNamespaces: ["SESSION"],
        assets: {
          binding: "ASSETS",
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
  // The typed form: build the Cloudflare deploy target as a *value* from the
  // shared worker options and pass it to the framework (`target:`). Astro
  // config rides alongside (the dev toolbar would differ between dev and the
  // built output, breaking the shared screenshots).
  framework: (options) =>
    Astro.layer({
      target: cloudflare({ worker: Options.resolveCloudflareOptions(options).worker }),
      astro: {
        devToolbar: { enabled: false },
        redirects: { "/old-about": "/about/" },
        // Emit stylesheets as hashed /_astro/ assets (instead of inlining)
        // so the generated _headers immutable Cache-Control rule is
        // observable end-to-end in live mode.
        build: { inlineStylesheets: "never" },
      },
    }),
});
