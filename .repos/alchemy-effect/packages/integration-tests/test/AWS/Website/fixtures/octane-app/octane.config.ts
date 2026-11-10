import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";

export default defineConfig({
  router: {
    routes: [
      new ServerRoute({
        path: "/api/hello",
        methods: ["GET"],
        handler: (context) => {
          return Response.json({
            marker: "OCTANE_AWS_API_MARKER",
            echo: context.url.searchParams.get("echo"),
          });
        },
      }),
      new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] }),
    ],
  },
});
