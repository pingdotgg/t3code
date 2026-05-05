import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: [
        {
          find: "react/jsx-runtime",
          replacement: new URL("../web/node_modules/react/jsx-runtime.js", import.meta.url)
            .pathname,
        },
        {
          find: "react/jsx-dev-runtime",
          replacement: new URL("../web/node_modules/react/jsx-dev-runtime.js", import.meta.url)
            .pathname,
        },
        {
          find: "react",
          replacement: new URL("../web/node_modules/react/index.js", import.meta.url).pathname,
        },
        {
          find: "react-dom/client",
          replacement: new URL("../web/node_modules/react-dom/client.js", import.meta.url).pathname,
        },
      ],
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide parallel runs they regularly exceed the default 15s budget.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
