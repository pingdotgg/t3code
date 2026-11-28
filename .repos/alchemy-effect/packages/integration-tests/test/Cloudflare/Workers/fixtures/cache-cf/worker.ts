// Async (non-Effect) Worker exercising the local runtime's Cache API
// simulator (`caches.default`) and the `request.cf` middleware.
declare const caches: {
  default: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
};

export default {
  fetch: async (request: Request & { cf?: Record<string, unknown> }) => {
    const url = new URL(request.url);
    if (url.pathname === "/cf") {
      return Response.json({
        colo: request.cf?.colo ?? null,
        country: request.cf?.country ?? null,
        clientAcceptEncoding: request.cf?.clientAcceptEncoding ?? null,
      });
    }
    if (url.pathname === "/cache") {
      // The cache simulator persists in `.alchemy/local` across runs — a
      // caller-supplied key keeps "first fetch misses" deterministic.
      const keyName = url.searchParams.get("key") ?? "cached-resource";
      const key = new Request(`https://example.com/${keyName}`);
      let hit = true;
      let res = await caches.default.match(key);
      if (!res) {
        hit = false;
        res = new Response("cached-body", {
          headers: { "Cache-Control": "public, max-age=60" },
        });
        await caches.default.put(key, res.clone());
      }
      return Response.json({ hit, body: await res.text() });
    }
    return new Response("not found", { status: 404 });
  },
};
