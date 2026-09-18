import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No @cloudflare/vite-plugin here — Alchemy's Website.Vite merges its own
// Cloudflare integration on top of this config at build time.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
