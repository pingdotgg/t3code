import { cloudflare } from "@octanejs/adapter-cloudflare";
import { defineConfig, RenderRoute } from "@octanejs/vite-plugin";
export default defineConfig({
  adapter: cloudflare(),
  router: {
    routes: [new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] })],
  },
});
