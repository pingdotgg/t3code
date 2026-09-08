import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Alchemy loads this config natively — plugins included — when it runs
// the Vite build for `AWS.Website.Vite`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
