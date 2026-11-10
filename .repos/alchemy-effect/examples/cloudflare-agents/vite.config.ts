import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// The Agents SDK starter's Vite config, unchanged: `agents()` compiles the
// `@callable()` decorators. Alchemy builds and serves the Worker in place of
// `@cloudflare/vite-plugin`.
export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
});
