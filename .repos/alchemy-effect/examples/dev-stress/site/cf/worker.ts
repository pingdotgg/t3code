/**
 * Asset-only entry for the Cloudflare `Website.StaticSite`. Every request
 * falls through to the static assets; the worker itself only answers
 * `/__worker` so the suite can tell "assets served" from "worker served".
 */
export default {
  fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/__worker") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
};
