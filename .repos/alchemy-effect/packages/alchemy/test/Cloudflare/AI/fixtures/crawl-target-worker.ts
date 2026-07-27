import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const page = (title: string, body: string) =>
  HttpServerResponse.html(
    `<!doctype html><html><head><title>${title}</title></head>` +
      `<body>${body}</body></html>`,
  );

/**
 * A tiny Worker that serves a small crawlable site. Its `workers.dev` URL is a
 * domain the account owns, so it can seed an AI Search web-crawler instance
 * (which rejects domains the account hasn't verified).
 *
 * It serves both a `robots.txt` (advertising the sitemap) and a `sitemap.xml`
 * listing every page, plus inline links between pages. Cloudflare validates a
 * web-crawler seed synchronously at create time and rejects with
 * `missing_sitemap` if it finds no content — which happened intermittently
 * when relying on link-discovery alone against a freshly-deployed
 * `workers.dev` URL. Serving a real sitemap (and `robots.txt` pointing at it)
 * makes the seed valid no matter which discovery path Cloudflare takes.
 */
export default class AiSearchCrawlTargetWorker extends Cloudflare.Worker<AiSearchCrawlTargetWorker>()(
  "AiSearchCrawlTargetWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `HttpServerRequest.url` is the request path (e.g. `/docs`), not an
        // absolute URL — `new URL(request.url)` would throw and 500. Match on
        // the path prefix directly. Build absolute URLs from the `Host`
        // header so the sitemap works behind the dynamic `workers.dev` host.
        const host = request.headers.host ?? "localhost";
        const origin = `https://${host}`;

        if (request.url.startsWith("/robots.txt")) {
          return HttpServerResponse.text(
            `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
          );
        }

        if (request.url.startsWith("/sitemap.xml")) {
          return HttpServerResponse.text(
            `<?xml version="1.0" encoding="UTF-8"?>` +
              `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
              `<url><loc>${origin}/</loc></url>` +
              `<url><loc>${origin}/docs</loc></url>` +
              `</urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        }

        if (request.url.startsWith("/docs")) {
          return page(
            "Docs",
            "<h1>Alchemy docs</h1><p>Indexable documentation content.</p>",
          );
        }

        return page(
          "Crawl Target",
          "<h1>Alchemy AI Search crawl target</h1>" +
            "<p>This page exists so AI Search has something to index.</p>" +
            '<p><a href="/docs">Docs</a></p>',
        );
      }),
    };
  }),
) {}
