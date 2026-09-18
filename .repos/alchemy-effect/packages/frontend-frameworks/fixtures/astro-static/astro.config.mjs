// A REAL user config file declaring a fully-static site. The integration
// must honor it (the user-config principle) AND respect what it implies:
// `output: "static"` means every route is prerendered at build time, so the
// production artifact is ASSETS-ONLY — the BuildOutput should carry NO
// server modules and the deploy should not create a worker.
// - `devToolbar` disabled so dev-mode HTML matches the built output.
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  devToolbar: { enabled: false },
});
