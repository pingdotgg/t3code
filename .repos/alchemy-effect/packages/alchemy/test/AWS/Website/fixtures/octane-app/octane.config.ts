import { aws } from "@alchemy.run/frontend-frameworks/octane/aws-adapter";
import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";

/**
 * The fixture's own octane.config.ts — the AWS deploy target requires the
 * marker adapter (`adapter: aws()`), which keeps Octane's default node
 * server build (`dist/server/entry.js` exporting the web fetch handler the
 * target's finishing pass wraps for Lambda).
 */
export default defineConfig({
  adapter: aws(),
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
