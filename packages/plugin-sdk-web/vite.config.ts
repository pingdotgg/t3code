import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

import { isPluginSdkWebExternal } from "./src/externals";

const webSrc = fileURLToPath(new URL("../../apps/web/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "~": webSrc,
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: isPluginSdkWebExternal,
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
