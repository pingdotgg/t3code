import { node } from "@alchemy.run/frontend-frameworks/octane/node-adapter";
import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";

export default defineConfig({
  adapter: node(),
  router: {
    routes: [
      new ServerRoute({
        path: "/api/hello",
        methods: ["GET"],
        handler: ({ url }) =>
          Response.json({
            name: url.searchParams.get("name") ?? "visitor",
            greeting: process.env.GREETING ?? "Hello!",
          }),
      }),
      new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] }),
    ],
  },
});
