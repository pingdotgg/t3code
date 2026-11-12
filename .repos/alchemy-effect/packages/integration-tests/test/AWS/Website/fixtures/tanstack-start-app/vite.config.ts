import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The fixture's own vite.config.ts — loaded natively by the integration.
 * Observable from the live test:
 *
 * - `__FIXTURE_MARKER__` is defined here and rendered on the SSR home page,
 *   proving the project's own config was applied.
 *
 * No deploy-target wiring here: TanStack Start is pure Vite, and the AWS
 * target wraps the emitted server entry after the build.
 */
export default defineConfig({
  plugins: [tanstackStart(), viteReact()],
  define: {
    __FIXTURE_MARKER__: JSON.stringify("tanstack-start-aws-user-config-loaded"),
  },
});
