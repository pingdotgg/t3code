import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Tests inline the WASM closure from assets/ with `?inline`.
  assetsInclude: ["**/*.wasm"],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
