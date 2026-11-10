// Alchemy loads this config natively — no adapter or `output` needed here,
// the Fly Machine adapter is managed by `Fly.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
