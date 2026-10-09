import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";

const prefix = "native-config";

export default defineConfig({
  build: { outDir: "output", minify: false },
  router: {
    routes: [
      new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] }),
      new RenderRoute({ path: "/other", entry: ["App", "/src/App.tsx"] }),
      new ServerRoute({
        path: "/api/hello",
        methods: ["GET"],
        handler: (context) => {
          const platform = context.platform as {
            env: { MESSAGE: string };
            ctx: { waitUntil: unknown };
          };
          return Response.json({
            message: `${prefix}:${platform.env.MESSAGE}`,
            hasWaitUntil: typeof platform.ctx.waitUntil === "function",
          });
        },
      }),
    ],
  },
});
