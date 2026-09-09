import { octane } from "@octanejs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [octane(), tailwindcss()],
  build: { target: "esnext" },
});
