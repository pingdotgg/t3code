import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * The fixture's own vite.config.ts — loaded natively by the integration.
 * Observable from the live test:
 *
 * - `__FIXTURE_MARKER__` is defined here and rendered on the SSR home page,
 *   proving the project's own config was applied.
 *
 * No deploy-target wiring here: `reactRouter()` owns both build
 * environments, and the AWS target wraps the emitted server entry after the
 * build.
 */
export default defineConfig({
  plugins: [reactRouter()],
  define: {
    __FIXTURE_MARKER__: JSON.stringify("react-router-aws-user-config-loaded"),
  },
});
