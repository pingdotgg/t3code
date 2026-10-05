import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
