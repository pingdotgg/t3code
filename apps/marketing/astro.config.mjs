import { defineConfig } from "astro/config";

const cacheSidebarDemoAssets = {
  name: "cache-sidebar-demo-assets",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith("/sidebar-demo/assets/")) {
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (
        request.url?.startsWith("/demo-states/") ||
        request.url?.startsWith("/mobile-states/")
      ) {
        response.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
      }
      next();
    });
  },
};

export default defineConfig({
  site: "https://t3.codes",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    plugins: [cacheSidebarDemoAssets],
  },
});
