import * as Astro from "@alchemy.run/frontend-frameworks/astro";
import cloudflare from "@alchemy.run/frontend-frameworks/astro/cloudflare";
import { Assets, Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

export const FIXTURE_VALUE = "hello-from-astro-ssr-binding";

export default Options.make({
  // Target-scoped config carriage: `target.cloudflare` carries the worker
  // config (dev/build) and the miniflare preview config.
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-astro-ssr",
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
  // Deliberately NO `astro:` overrides here — unlike fixtures/astro, this
  // fixture's Astro configuration lives in its real `astro.config.mjs`,
  // which the integration must load and honor (the user-config principle).
  framework: (options) =>
    Astro.layer({
      target: cloudflare({ worker: Options.resolveCloudflareOptions(options).worker }),
    }),
});
