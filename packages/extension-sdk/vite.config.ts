import { defineConfig } from "vite-plus";
export default defineConfig({
  pack: { entry: ["src/index.ts", "src/panel.ts"], dts: true, clean: true },
});
