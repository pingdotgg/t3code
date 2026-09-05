import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    ssr: "src/bin.ts",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "t3-mcp-gateway.mjs",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
