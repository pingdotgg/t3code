import { cloudflare } from "@octanejs/adapter-cloudflare";
import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";

/**
 * The Cloudflare request context the adapter forwards as `context.platform`
 * in production. In dev, Octane's Vite middleware supplies no platform
 * (upstream limitation), so handlers must tolerate `undefined`.
 */
interface Platform {
  readonly env?: Record<string, unknown>;
  readonly ctx?: { readonly waitUntil?: unknown };
}

export default defineConfig({
  adapter: cloudflare(),
  router: {
    routes: [
      new ServerRoute({
        path: "/api/hello",
        methods: ["GET"],
        handler: (context) => {
          const platform = context.platform as Platform | undefined;
          return Response.json({
            marker: "api-route-ok",
            secret: (platform?.env?.FIXTURE_SECRET as string | undefined) ?? null,
            hasWaitUntil: typeof platform?.ctx?.waitUntil === "function",
          });
        },
      }),
      new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] }),
    ],
  },
});
