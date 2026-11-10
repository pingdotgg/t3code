// A REAL user config file — the point of this fixture. The integration must
// honor it (the "respect user config files" principle) rather than pinning
// `configFile: false`. Every setting here is user-observable and asserted by
// the Playwright suite:
// - `output: "server"` — SSR-first: every route is on-demand unless it opts
//   into prerendering (`/about/` is the single hybrid exception).
// - `redirects` — `/legacy-greeting` must redirect to the on-demand
//   `/greet/astro` route (dynamic, so it must be handled by the worker in
//   both dev and live — there is no prerendered target to fall back to).
// - `security.checkOrigin: false` — the suite POSTs forms straight to the
//   server (no Origin header); the default `checkOrigin: true` would 403.
// - `devToolbar` disabled so dev-mode HTML matches the built output.
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  devToolbar: { enabled: false },
  redirects: { "/legacy-greeting": "/greet/astro" },
  security: { checkOrigin: false },
});
