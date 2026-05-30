import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // The web runtime suite exercises auth bootstrap, saved environments,
      // and websocket subscription lifecycles. Under the full monorepo test
      // run, those async tests can exceed Vitest's default 5s budget.
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  }),
);
