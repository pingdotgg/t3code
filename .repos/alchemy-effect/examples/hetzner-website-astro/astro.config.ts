// Alchemy loads this config natively — no adapter or `output` needed here,
// the Hetzner Server adapter is managed by `Hetzner.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
