import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
