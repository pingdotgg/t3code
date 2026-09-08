import tailwindcss from "@tailwindcss/vite";
import { defineNuxtConfig } from "nuxt/config";

// The project's own nuxt.config.ts loads natively — Alchemy only overlays
// what the Cloudflare deploy needs (nitro's cloudflare_module preset).
// Do NOT set `nitro.preset` here; the deploy target owns it.
export default defineNuxtConfig({
  compatibilityDate: "2026-07-01",
  telemetry: { enabled: false },
  // Tailwind CSS v4 wired through this config — proof the project's own
  // nuxt.config.ts (vite plugins included) is loaded by the Alchemy build.
  css: ["~/assets/css/main.css"],
  vite: {
    plugins: [tailwindcss()],
  },
  routeRules: {
    "/about": { prerender: true },
  },
});
