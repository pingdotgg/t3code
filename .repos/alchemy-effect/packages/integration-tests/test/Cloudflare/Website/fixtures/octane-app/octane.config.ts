import { cloudflare } from "@octanejs/adapter-cloudflare";
import { defineConfig, RenderRoute, ServerRoute } from "@octanejs/vite-plugin";

/**
 * The Cloudflare request context the adapter forwards as `context.platform`
 * in production (`{ env, ctx }`). In dev, Octane's Vite middleware supplies
 * no platform (upstream limitation), so handlers tolerate `undefined`.
 */
interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Platform {
  readonly env?: {
    readonly TEST_BINDING?: string;
    readonly SITE_KV?: KvBinding;
  };
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
            binding: platform?.env?.TEST_BINDING ?? null,
            hasWaitUntil: typeof platform?.ctx?.waitUntil === "function",
          });
        },
      }),
      new ServerRoute({
        path: "/api/kv",
        methods: ["GET", "PUT"],
        handler: async (context) => {
          const platform = context.platform as Platform | undefined;
          const kv = platform?.env?.SITE_KV;
          const key = context.url.searchParams.get("key") ?? "";
          if (kv === undefined || key === "") {
            return Response.json({ error: "no kv or key" }, { status: 500 });
          }
          if (context.request.method === "PUT") {
            const value = context.url.searchParams.get("value") ?? "";
            await kv.put(key, value);
            return Response.json({ put: true, key });
          }
          return Response.json({ key, value: await kv.get(key) });
        },
      }),
      new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] }),
    ],
  },
});
