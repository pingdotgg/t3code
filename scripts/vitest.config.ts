import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/ai-loop.spec.ts", "tests/port-policy.spec.ts"],
  },
});
