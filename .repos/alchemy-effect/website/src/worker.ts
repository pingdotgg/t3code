import type { WorkerEnv } from "../alchemy.run.ts";

// Minimal `HTMLRewriter` shape — the workers runtime exposes it as a
// global, but we don't pull in `@cloudflare/workers-types`, so declare
// just what this file uses.
declare class HTMLRewriter {
  on(
    selector: string,
    handler: { element(el: HTMLRewriterElement): void },
  ): HTMLRewriter;
  transform(response: Response): Response;
}
interface HTMLRewriterElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): HTMLRewriterElement;
}

/**
 * Astro bakes absolute URLs into `<meta property="og:image">`,
 * `og:url`, `twitter:image`, and `<link rel="canonical">` at build time
 * using the `site` config (`https://v2.alchemy.run`). PR previews and
 * custom domains then advertise OG / canonical URLs that point back at
 * the canonical host — so a Slack/Twitter unfurl of a preview URL
 * fetches the *production* card, not the one for the page being
 * shared.
 *
 * Rewrite those tags at the edge to match the request's actual host so
 * each deployment unfurls itself.
 */
const CANONICAL_HOST = "v2.alchemy.run";

export default {
  fetch: async (request: Request, env: WorkerEnv) => {
    if (request.method === "GET" && prefersMarkdown(request)) {
      const mdUrl = toMarkdownUrl(new URL(request.url)).toString();
      const res = await env.ASSETS.fetch(new Request(mdUrl, request));
      // Astro's asset server labels `.md` as `application/octet-stream`, which
      // agents treat as a binary download instead of rendering. Force the
      // correct text type + charset since this branch only ever serves markdown.
      if (res.status !== 404)
        return withContentType(res, "text/markdown; charset=utf-8");
    }
    const res = await env.ASSETS.fetch(request);
    return withUtf8Charset(rewriteCanonicalHost(request, res));
  },
};

/**
 * Astro's static asset server labels `.txt` as `text/plain` with no charset.
 * UTF-8 bytes (em dashes, arrows in our docs and `llms.txt`) then get decoded
 * as latin-1 by browsers and agents, showing up as mojibake (`â€"`). Stamp
 * `charset=utf-8` on text responses that omit it.
 */
const withUtf8Charset = (res: Response): Response => {
  const ct = res.headers.get("content-type");
  if (!ct || !ct.startsWith("text/") || /charset=/i.test(ct)) return res;
  return withContentType(res, `${ct}; charset=utf-8`);
};

const withContentType = (res: Response, contentType: string): Response => {
  const next = new Response(res.body, res);
  next.headers.set("content-type", contentType);
  return next;
};

const rewriteCanonicalHost = (request: Request, res: Response): Response => {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return res;
  const reqUrl = new URL(request.url);
  if (reqUrl.host === CANONICAL_HOST) return res;

  class HostRewriter {
    attr: "content" | "href";
    constructor(attr: "content" | "href") {
      this.attr = attr;
    }
    element(el: HTMLRewriterElement) {
      const value = el.getAttribute(this.attr);
      if (!value) return;
      let u: URL;
      try {
        u = new URL(value);
      } catch {
        return;
      }
      if (u.host !== CANONICAL_HOST) return;
      u.protocol = reqUrl.protocol;
      u.host = reqUrl.host;
      el.setAttribute(this.attr, u.toString());
    }
  }

  const content = new HostRewriter("content");
  const href = new HostRewriter("href");

  return new HTMLRewriter()
    .on('meta[property="og:image"]', content)
    .on('meta[property="og:url"]', content)
    .on('meta[name="twitter:image"]', content)
    .on('link[rel="canonical"]', href)
    .transform(res);
};

/**
 * Returns true if the accept header prefers markdown or plain text over HTML.
 *
 * Examples:
 * - opencode - accept: text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, *\/*;q=0.1
 * - claude code - accept: application/json, text/plain, *\/*
 *
 * Notes:
 * - ChatGPT and Claude web don't set an accept header; maybe check the user agent instead?
 * - Cursor's headers are too generic (accept: *, user-agent: https://github.com/sindresorhus/got)
 */
const prefersMarkdown = (request: Request) => {
  const accept = request.headers.get("accept");
  if (!accept) return false;

  // parse accept header and sort by quality; highest quality first
  const types = accept
    .split(",")
    .map((part) => {
      const type = part.split(";")[0].trim();
      const q = part.match(/q=([^,]+)/)?.[1];
      return { type, q: q ? Number.parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q)
    .map((type) => type.type);

  const markdown = types.indexOf("text/markdown");
  const plain = types.indexOf("text/plain");
  const html = types.indexOf("text/html");

  // if no HTML is specified, and either markdown or plain text is specified, prefer markdown
  if (html === -1) {
    return markdown !== -1 || plain !== -1;
  }

  // prefer markdown if higher quality than HTML
  if ((markdown !== -1 && markdown < html) || (plain !== -1 && plain < html)) {
    return true;
  }

  // otherwise, prefer HTML
  return false;
};

function toMarkdownUrl(url: URL): URL {
  const md = new URL(url.toString());
  let p = md.pathname.replace(/\/$/, "");
  if (p === "") p = "/index";
  md.pathname = `${p}.md`;
  return md;
}
