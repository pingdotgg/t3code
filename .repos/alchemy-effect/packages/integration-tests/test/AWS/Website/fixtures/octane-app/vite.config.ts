import { octane } from "@octanejs/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [octane()],
  build: { target: "esnext" },
});
