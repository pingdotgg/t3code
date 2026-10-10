// Alchemy loads this config natively — no adapter or `output` needed here,
// the Neon Functions runtime adapter is managed by `Neon.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
