import { solidStart } from "@solidjs/start/config";
import { defineConfig } from "vite";

/**
 * The fixture's own vite.config.ts — loaded natively by the integration.
 * Observable from the live test:
 *
 * - `__FIXTURE_MARKER__` is defined here and rendered on the SSR home page,
 *   proving the project's own config was applied.
 *
 * NO `nitroV2Plugin()` here: the AWS deploy target owns the nitro preset and
 * the integration appends its own instance.
 */
export default defineConfig({
  plugins: [solidStart()],
  define: {
    __FIXTURE_MARKER__: JSON.stringify("solidstart-aws-user-config-loaded"),
  },
});
