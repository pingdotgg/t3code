// Hand-rolled SSR shape (the solidjs-ssr example / docs-site pattern): the
// client build emits index.html — an asset that would shadow `/` under
// assets-first routing — so the worker runs first, renders every page, and
// delegates real static files to the ASSETS binding itself.
type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
};

const page = (path: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>worker-first rendered</title>
  </head>
  <body>
    <div id="app">worker-first-rendered:${path}</div>
  </body>
</html>
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/") || url.pathname === "/robots.txt") {
      return env.ASSETS.fetch(request);
    }
    return new Response(page(url.pathname), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
