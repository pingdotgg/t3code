// Alchemy loads this config natively — no adapter or `output` needed here,
// the Railway Service adapter is managed by `Railway.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
