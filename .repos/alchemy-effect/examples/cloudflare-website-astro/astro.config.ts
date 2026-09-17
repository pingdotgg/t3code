// Alchemy loads this config natively — no adapter or `output` needed here,
// the Cloudflare adapter is managed by `Cloudflare.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
