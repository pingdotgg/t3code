// Alchemy loads this config natively — no adapter or `output` needed here,
// the AWS Lambda adapter is managed by `AWS.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
