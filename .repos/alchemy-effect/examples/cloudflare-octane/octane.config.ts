import { cloudflare } from "@octanejs/adapter-cloudflare";
import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";

/**
 * The Cloudflare request context the adapter forwards as `context.platform`
 * in production (`{ env, ctx }`). Octane's dev server supplies no platform
 * (bindings are live-only), so handlers tolerate `undefined` in dev.
 */
interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Platform {
  readonly env?: { readonly CACHE?: KvBinding };
  readonly ctx?: { readonly waitUntil?: (promise: Promise<unknown>) => void };
}

export default defineConfig({
  adapter: cloudflare(),
  router: {
    routes: [
      new ServerRoute({
        path: "/api/visits",
        methods: ["GET"],
        handler: async (context) => {
          const platform = context.platform as Platform | undefined;
          const cache = platform?.env?.CACHE;
          if (cache === undefined) {
            // Octane's dev server has no bindings — deploy to try this route.
            return Response.json({ visits: null, dev: true });
          }
          const visits = Number((await cache.get("visits")) ?? "0") + 1;
          await cache.put("visits", String(visits));
          return Response.json({ visits });
        },
      }),
      new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] }),
    ],
  },
});
