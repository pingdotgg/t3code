import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import vike from "vike/plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vike(), react(), cloudflare({ viteEnvironment: { name: "ssr" } })],
});
