// The cross-boundary import this fixture exists to exercise: `lib/` is a
// sibling of `app/` (the Vite root), with its own package.json — the
// workspace-aware input hash must fold `lib/` into the memo signal.
import { greeting, LIB_VERSION } from "../../lib/src/greeting.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/greeting") {
      return Response.json({
        greeting: greeting("api"),
        libVersion: LIB_VERSION,
      });
    }
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>monorepo-workspace fixture</title>
  </head>
  <body>
    <h1 id="greeting">${greeting("ssr")}</h1>
    <p id="lib-version">${LIB_VERSION}</p>
  </body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
