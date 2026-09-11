import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import path from "node:path";

export default Options.make({
  vite: {
    main: path.resolve(import.meta.dirname, "react-router-vite/entry.worker.tsx"),
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    viteEnvironments: { entry: "rsc", children: ["ssr"] },
    worker: {
      name: "fixtures-react-router-rsc",
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
