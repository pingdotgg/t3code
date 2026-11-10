// @ts-check
import { defineConfig } from "astro/config";

// On-demand SSR by default; individual pages opt into prerendering
// (`about.astro`). Loaded natively by the integration — the config file is
// authoritative (the toolchain injects its adapter without overriding
// `output`; before the user-config principle landed the integration pinned
// `output: "server"` itself, which is why this file didn't exist).
//
// The extra settings are user-observable and asserted by the live test:
// - `redirects` — the adapter emits `/old-about /about/ 301` into
//   `_redirects`; alchemy's asset upload must honor it so the asset layer
//   answers with a real 3xx.
// - `security.checkOrigin: false` — the test POSTs the feedback form via a
//   direct fetch (no Origin header); Astro's default CSRF check would 403.
// - `build.inlineStylesheets: "never"` — forces the stylesheet imported by
//   `about.astro` to emit as a hashed `/_astro/*.css` asset so the test can
//   pin the `_headers`-driven immutable Cache-Control on hashed assets.
export default defineConfig({
  output: "server",
  redirects: { "/old-about": "/about/" },
  security: { checkOrigin: false },
  build: { inlineStylesheets: "never" },
});
