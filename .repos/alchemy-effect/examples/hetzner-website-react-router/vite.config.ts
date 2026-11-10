// Alchemy loads this config natively — no adapter or server preset needed
// here, the Node wrapper is managed by `Hetzner.Website.ReactRouter`.
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
});
