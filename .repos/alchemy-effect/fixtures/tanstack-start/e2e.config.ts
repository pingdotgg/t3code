import { Text } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Config.string("TEST_POSTGRES_URL").pipe(
  Config.orElse(() => Config.succeed("")),
  Effect.map((url) =>
    Options.make({
      vite: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-tanstack-start",
          bindings: [Text.local("TEST_POSTGRES_URL", url)],
          assets: {
            // Assets are matched ahead of the worker (`runWorkerFirst`
            // deliberately unset): the TanStack worker has no ASSETS-binding
            // fallback, so `runWorkerFirst: true` would 404 every static
            // asset (verified against miniflare with
            // `invoke_user_worker_ahead_of_assets: true`). This now matches
            // the preview router config below — the two used to disagree.
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      miniflare: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { TEST_POSTGRES_URL: url },
        assets: {
          routerConfig: {
            has_user_worker: true,
            // Parity with the worker config above: assets first, worker for
            // everything unmatched.
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
    }),
  ),
);
