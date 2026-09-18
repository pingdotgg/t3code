import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import path from "node:path";

// Target-scoped config carriage (the canonical form): `target.cloudflare`
// carries the worker config (dev/build) and the miniflare preview config.
// The deprecated top-level `vite`/`miniflare` aliases keep working for
// fixtures that still use them.
//
// Static site WITH a worker in front: `main` builds `src/server.ts` as the
// user worker. Assets are matched first (`runWorkerFirst` unset), so the
// worker only sees requests no static asset answers — the `/api/hello`
// route plus everything unmatched (`not_found_handling: "none"` means the
// asset layer never falls back; the worker owns the 404).
export default Options.make({
  target: {
    cloudflare: {
      worker: {
        main: path.resolve(import.meta.dirname, "src/server.ts"),
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          name: "fixtures-static-website",
          bindings: [],
          assets: {
            htmlHandling: "auto-trailing-slash",
            notFoundHandling: "none",
          },
        },
      },
      preview: {
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
    },
  },
});
