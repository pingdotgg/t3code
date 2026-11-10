// Minimal worker entry. The cloudflare-vite-plugin wraps this in a
// virtual module and emits it as the SSR bundle. We delegate to the
// asset binding (`ASSETS.fetch`) so the actual fixture content (the
// built `index.html`) is what's served — that's what the test is
// checking on subsequent deploys.
type Env = { ASSETS: { fetch: (req: Request) => Promise<Response> } };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
