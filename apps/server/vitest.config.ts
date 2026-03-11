import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  }),
);
