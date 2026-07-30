import { renderToStringAsync, generateHydrationScript } from "solid-js/web";
import { StaticRouter } from "@solidjs/router";
import App from "./app";
import { routes } from "./routes";

const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Solid App</title>
<!--ssr-head-->
</head>
<body>
<div id="root"><!--ssr-outlet--></div>
</body>
</html>`;

async function getTemplate(
  env: { ASSETS: Fetcher },
  origin: string,
): Promise<string> {
  try {
    const res = await env.ASSETS.fetch(new Request(origin + "/index.html"));
    if (res.ok) {
      const text = await res.text();
      if (text.length > 0) return text;
    }
  } catch {}
  return FALLBACK_HTML;
}

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Serve static assets via the assets binding
      if (pathname.startsWith("/assets/") || pathname.endsWith(".ico")) {
        return env.ASSETS.fetch(request);
      }

      // Get the HTML template (from assets if available, fallback to bare HTML)
      const template = await getTemplate(env, url.origin);

      // Render the SolidJS app to HTML on the server
      const appHtml = await renderToStringAsync(() => (
        <StaticRouter
          url={pathname}
          root={(props) => <App>{props.children}</App>}
        >
          {routes}
        </StaticRouter>
      ));

      // Inject the server-rendered HTML and hydration script
      const html = template
        .replace("<!--ssr-head-->", generateHydrationScript())
        .replace("<!--ssr-outlet-->", appHtml);

      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (e: any) {
      return new Response(`SSR Error: ${e.message}\n\n${e.stack}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};
