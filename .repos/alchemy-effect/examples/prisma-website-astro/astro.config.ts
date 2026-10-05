// Alchemy loads this config natively — no adapter or `output` needed here,
// the Prisma Compute runtime adapter is managed by `Prisma.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
