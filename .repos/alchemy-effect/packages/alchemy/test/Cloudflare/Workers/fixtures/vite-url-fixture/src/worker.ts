// Worker entry for the `Worker.URL` vite fixture. `/self-url` reports the
// URL through both channels the binding feeds:
// - `inlined`: replaced at build time by the `define` derived from `env`
//   (this is how VITE_*-prefixed values reach client bundles), and
// - `env`: the plain_text binding injected at deploy time.
type Env = {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  VITE_PUBLIC_URL: string;
};

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/self-url") {
      return Response.json({
        inlined: (import.meta.env as { VITE_PUBLIC_URL?: string })
          .VITE_PUBLIC_URL,
        env: env.VITE_PUBLIC_URL,
      });
    }
    return env.ASSETS.fetch(request);
  },
};
