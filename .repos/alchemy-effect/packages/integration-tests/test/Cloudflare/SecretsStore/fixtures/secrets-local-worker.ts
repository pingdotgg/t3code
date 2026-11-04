// Async (non-Effect) Worker that exercises the native `secrets_store_secret`
// binding: `/secret` reads `env.SECRET.get()` and echoes the value. Used by
// the local (dev) test against both the local simulator and, via
// `Alchemy.remote()`, the remote-proxied live binding.
interface Env {
  SECRET: { get(): Promise<string> };
}

export default {
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/secret") {
      try {
        const value = await env.SECRET.get();
        return Response.json({ value });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 404 });
      }
    }
    return new Response("Not Found", { status: 404 });
  },
};
