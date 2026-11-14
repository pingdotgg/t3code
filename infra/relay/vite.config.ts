import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: {
      alwaysBundle: ["@t3tools/*"],
    },
  },
});
