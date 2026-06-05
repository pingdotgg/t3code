// vitest.config.ts
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths() as any],
  test: {
    globals: true,
    environment: "node", // or 'jsdom' for frontend tests
    include: ["alchemy/test/**/*.test.ts"],
  },
});
