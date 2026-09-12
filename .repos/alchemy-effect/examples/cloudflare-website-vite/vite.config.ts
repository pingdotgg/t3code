import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Alchemy loads this config natively and merges its own Cloudflare
// integration on top — plugins included, no @cloudflare/vite-plugin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
