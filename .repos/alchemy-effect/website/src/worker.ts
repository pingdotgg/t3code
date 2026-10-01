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
 * `https://alchemy.run` is the one indexable origin. Every other host this
 * worker answers on — `main.alchemy.run`, PR previews on `*.workers.dev`,
 * future aliases — is a mirror of the same build:
 *
 * - `<link rel="canonical">` is baked at build time against `site` and is left
 *   alone, so mirrors point search engines back at production.
 * - Every mirror response carries `X-Robots-Tag: noindex` and its `robots.txt`
 *   advertises no sitemap, so a mirror URL that leaks (a PR comment, a shared
 *   link) never becomes a duplicate search result.
 * - `og:*` / `twitter:*` card URLs ARE rewritten to the request host, so a
 *   Slack/X unfurl of a preview URL shows that preview's card, not
 *   production's.
 */
const CANONICAL_HOST = "alchemy.run";
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;

/**
 * The v1 docs moved to their own host. v1-era URLs (`/docs/...`, and the
 * pre-hub `/guides/...` / `/providers/...` / `/concepts/...` trees) are still
 * in search indexes; instead of 404ing them we probe v1 and 301 when it has
 * the page.
 */
const V1_ORIGIN = "https://v1.alchemy.run";
const V1_PREFIXES = ["/docs/", "/guides/", "/providers/", "/concepts/"];

/**
 * 301s for the docs restructure (guides/tutorials moved into per-cloud hubs).
 * Keys and targets are extensionless; `.md` requests (agents fetching raw
 * markdown) are redirected to the target's `.md` form with any fragment
 * dropped.
 */
const REDIRECTS: Record<string, string> = {
  "/tutorial/part-1": "/cloudflare/tutorial/part-1",
  "/tutorial/part-2": "/cloudflare/tutorial/part-2",
  "/tutorial/part-3": "/cloudflare/tutorial/part-3",
  "/tutorial/part-4": "/cloudflare/tutorial/part-4",
  "/tutorial/part-5": "/cloudflare/tutorial/part-5",
  "/tutorial/cloudflare/compute/durable-objects":
    "/cloudflare/compute/durable-objects",
  "/tutorial/cloudflare/data/hyperdrive": "/cloudflare/data/hyperdrive",
  "/tutorial/cloudflare/queue-consumer": "/cloudflare/messaging/queues",
  "/tutorial/cloudflare/rpc-durable-object":
    "/cloudflare/compute/durable-objects#schemaless-rpc",
  "/tutorial/cloudflare/rpc-worker":
    "/cloudflare/compute/workers#call-another-worker",
  "/tutorial/cloudflare/ai-gateway": "/cloudflare/ai/ai-gateway",
  "/tutorial/cloudflare/ai-search": "/cloudflare/ai/ai-search",
  "/tutorial/cloudflare/artifacts": "/cloudflare/data/artifacts",
  "/tutorial/cloudflare/branch-from-shared-database":
    "/cloudflare/data/branch-from-shared-database",
  "/tutorial/cloudflare/compute/containers":
    "/cloudflare/compute/run-a-container",
  "/tutorial/cloudflare/cross-worker-durable-object":
    "/cloudflare/compute/cross-worker-durable-object",
  "/tutorial/cloudflare/drizzle": "/cloudflare/data/drizzle",
  "/tutorial/cloudflare/hibernatable-websockets":
    "/cloudflare/compute/hibernatable-websockets",
  "/tutorial/cloudflare/vite-spa": "/cloudflare/frontend/vite-spa",
  "/tutorial/cloudflare/compute/workflows":
    "/cloudflare/compute/add-a-workflow",
  "/tutorial/aws/compute/lambda": "/aws/compute/lambda",
  "/tutorial/aws/data/dynamodb": "/aws/data/dynamodb",
  "/tutorial/aws/messaging/sqs": "/aws/messaging/sqs",
  "/tutorial/aws/data/s3": "/aws/data/s3",
  "/tutorial/aws/messaging/kinesis": "/aws/messaging/kinesis",
  "/tutorial/aws/api-gateway": "/aws/apis/api-gateway",
  "/tutorial/aws/dynamodb-streams": "/aws/messaging/dynamodb-streams",
  "/tutorial/aws/s3-events": "/aws/messaging/s3-events",
  "/guides/effect-http-api": "/cloudflare/apis/effect-http-api",
  "/guides/effect-rpc": "/cloudflare/apis/effect-rpc",
  "/guides/effect-ai": "/cloudflare/ai/effect-ai",
  "/guides/frontends": "/cloudflare/frontend/frontends",
  "/guides/shared-database": "/cloudflare/data/shared-database",
  // Absorbed into the Security & secrets block pages.
  "/guides/secrets": "/cloudflare/security/secrets-env",
  "/guides/stack-references": "/infrastructure-as-code/references",
  // The CLI reference became its own hub tab.
  "/guides/cli": "/cli",
  "/aws/guides/secrets": "/aws/security/secrets-env",
  // The Integrations tab was replaced by per-provider hubs (PlanetScale and
  // Neon promoted to top-level tabs; Axiom and GitHub in the More menu).
  // Section-folder alignment: file locations now mirror the sidebar taxonomy.
  "/aws/choosing-a-runtime": "/aws/compute/choosing-a-runtime",
  "/aws/cloudwatch": "/aws/observability/cloudwatch",
  "/aws/dynamodb": "/aws/data/dynamodb",
  "/aws/ec2": "/aws/compute/ec2",
  "/aws/ecs": "/aws/compute/ecs",
  "/aws/eks": "/aws/compute/eks",
  "/aws/eventbridge": "/aws/messaging/eventbridge",
  "/aws/guides/api-gateway": "/aws/apis/api-gateway",
  "/aws/guides/custom-domains": "/aws/networking/custom-domains",
  "/aws/guides/dynamodb-streams": "/aws/messaging/dynamodb-streams",
  "/aws/guides/effect-http-api": "/aws/apis/effect-http-api",
  "/aws/guides/effect-rpc": "/aws/apis/effect-rpc",
  "/aws/guides/microvms": "/aws/compute/microvms",
  "/aws/guides/s3-events": "/aws/messaging/s3-events",
  "/aws/guides/static-site": "/aws/frontend/static-site",
  "/aws/kinesis": "/aws/messaging/kinesis",
  "/aws/lambda": "/aws/compute/lambda",
  "/aws/rds": "/aws/data/rds",
  "/aws/s3": "/aws/data/s3",
  "/aws/secrets-env": "/aws/security/secrets-env",
  "/aws/sns": "/aws/messaging/sns",
  "/aws/sqs": "/aws/messaging/sqs",
  "/aws/websites": "/aws/frontend/websites",
  "/axiom/ingest": "/axiom/data/ingest",
  "/cloudflare/containers": "/cloudflare/compute/containers",
  "/cloudflare/d1": "/cloudflare/data/d1",
  "/cloudflare/domains": "/cloudflare/networking/domains",
  "/cloudflare/durable-objects": "/cloudflare/compute/durable-objects",
  "/cloudflare/guides/ai-gateway": "/cloudflare/ai/ai-gateway",
  "/cloudflare/guides/ai-search": "/cloudflare/ai/ai-search",
  "/cloudflare/guides/analytics-engine":
    "/cloudflare/observability/analytics-engine",
  "/cloudflare/guides/artifacts": "/cloudflare/data/artifacts",
  "/cloudflare/guides/axiom-observability":
    "/cloudflare/observability/axiom-observability",
  "/cloudflare/guides/branch-from-shared-database":
    "/cloudflare/data/branch-from-shared-database",
  "/cloudflare/guides/browser-rendering":
    "/cloudflare/compute/browser-rendering",
  "/cloudflare/guides/containers": "/cloudflare/compute/run-a-container",
  "/cloudflare/guides/cron": "/cloudflare/messaging/cron",
  "/cloudflare/guides/cross-worker-durable-object":
    "/cloudflare/compute/cross-worker-durable-object",
  "/cloudflare/guides/custom-domains": "/cloudflare/networking/custom-domains",
  "/cloudflare/guides/drizzle": "/cloudflare/data/drizzle",
  "/cloudflare/guides/effect-ai": "/cloudflare/ai/effect-ai",
  "/cloudflare/guides/effect-http-api": "/cloudflare/apis/effect-http-api",
  "/cloudflare/guides/effect-rpc": "/cloudflare/apis/effect-rpc",
  "/cloudflare/guides/email": "/cloudflare/email/send-and-receive",
  "/cloudflare/guides/frontends": "/cloudflare/frontend/frontends",
  "/cloudflare/guides/github-events": "/cloudflare/messaging/github-events",
  "/cloudflare/guides/hibernatable-websockets":
    "/cloudflare/compute/hibernatable-websockets",
  "/cloudflare/guides/release-agent": "/cloudflare/ai/release-agent",
  "/cloudflare/guides/secrets-store": "/cloudflare/security/secrets-store",
  "/cloudflare/guides/shared-database": "/cloudflare/data/shared-database",
  "/cloudflare/guides/tunnel": "/cloudflare/networking/tunnel",
  "/cloudflare/guides/turnstile": "/cloudflare/security/turnstile",
  "/cloudflare/guides/vectorize": "/cloudflare/ai/vectorize",
  "/cloudflare/guides/vite-spa": "/cloudflare/frontend/vite-spa",
  "/cloudflare/guides/workers-for-platforms":
    "/cloudflare/compute/workers-for-platforms",
  "/cloudflare/guides/workflows": "/cloudflare/compute/add-a-workflow",
  "/cloudflare/hyperdrive": "/cloudflare/data/hyperdrive",
  "/cloudflare/kv": "/cloudflare/data/kv",
  "/cloudflare/queues": "/cloudflare/messaging/queues",
  "/cloudflare/r2": "/cloudflare/data/r2",
  "/cloudflare/secrets-env": "/cloudflare/security/secrets-env",
  "/cloudflare/workers": "/cloudflare/compute/workers",
  "/cloudflare/workflows": "/cloudflare/compute/workflows",
  "/concepts/action": "/infrastructure-as-code/action",
  "/concepts/binding": "/infrastructure-as-effects/binding",
  "/concepts/layers": "/infrastructure-as-effects/layers",
  "/concepts/local-development": "/environments/local-development",
  "/concepts/observability": "/testing/observability",
  "/concepts/outputs": "/infrastructure-as-code/outputs",
  "/concepts/phases": "/infrastructure-as-effects/phases",
  "/concepts/platform": "/infrastructure-as-effects/runtime",
  "/infrastructure-as-effects/platform": "/infrastructure-as-effects/runtime",
  "/infrastructure-as-effects/functions-and-servers":
    "/infrastructure-as-effects/runtime",
  "/rpc": "/apis",
  "/rpc/schemaless": "/apis/schemaless",
  "/rpc/effect-rpc": "/apis/effect-rpc",
  "/rpc/effect-http": "/apis/effect-http",
  "/concepts/profiles": "/environments/profiles",
  "/concepts/provider": "/infrastructure-as-code/provider",
  "/concepts/references": "/infrastructure-as-code/references",
  "/concepts/resource": "/infrastructure-as-code/resource",
  "/concepts/resource-lifecycle": "/infrastructure-as-code/resource-lifecycle",
  "/concepts/secrets": "/environments/secrets",
  "/concepts/stack": "/infrastructure-as-code/stack",
  "/concepts/stages": "/environments/stages",
  "/concepts/state-store": "/state-store",
  "/concepts/test-harness": "/testing/test-harness",
  "/concepts/testing": "/testing",
  "/fly/frontend": "/fly/frontend/websites",
  "/fly/websites": "/fly/frontend/websites",
  "/guides/ci": "/environments/ci",
  "/guides/circular-bindings": "/infrastructure-as-effects/circular-bindings",
  "/guides/custom-provider": "/infrastructure-as-code/custom-provider",
  "/guides/custom-state-store": "/state-store/custom-state-store",
  "/guides/file-layout": "/project-structure/file-layout",
  "/guides/infrastructure-layers": "/infrastructure-as-effects/layers",
  "/infrastructure-as-effects/infrastructure-layers":
    "/infrastructure-as-effects/layers",
  "/guides/migrating-from-v1": "/migrating-from-v1",
  "/guides/monorepo": "/project-structure/monorepo",
  "/guides/monorepo-multi-stack": "/project-structure/monorepo-multi-stack",
  "/guides/monorepo-single-stack": "/project-structure/monorepo-single-stack",
  "/guides/testing-a-stack": "/testing/testing-a-stack",
  "/guides/testing-providers": "/testing/testing-providers",
  "/hetzner/frontend": "/hetzner/frontend/websites",
  "/hetzner/websites": "/hetzner/frontend/websites",
  "/neon/branching": "/neon/data/branching",
  "/neon/connections": "/neon/data/connections",
  "/neon/migrations": "/neon/data/migrations",
  "/planetscale/backups": "/planetscale/data/backups",
  "/planetscale/credentials": "/planetscale/data/credentials",
  "/planetscale/migrations": "/planetscale/data/migrations",
  "/planetscale/mysql": "/planetscale/data/mysql",
  "/planetscale/postgres": "/planetscale/data/postgres",
  "/railway/frontend": "/railway/frontend/websites",
  "/railway/websites": "/railway/frontend/websites",
  "/integrations": "/providers",
  "/integrations/planetscale": "/planetscale",
  "/integrations/neon": "/neon",
  "/integrations/axiom": "/axiom",
  "/integrations/github": "/github",
  "/git/auth": "/git/blocks/auth",
  "/git/storage": "/git/blocks/repositories",
  "/git/assemblies": "/git/recipes",
  "/git/assemblies/cloudflare": "/git/recipes/cloudflare",
  "/git/assemblies/cloudflare-aws": "/git/recipes/cloudflare-aws",
  "/git/assemblies/one-origin": "/git/tutorial/part-4",
  "/git/build": "/git/tutorial/part-4",
  "/git/scale": "/git/recipes/scaling",
  "/git/scale/pushes": "/git/blocks/hasher",
  "/git/scale/clones": "/git/blocks/repositories",
};

const resolveRedirect = (url: URL): string | undefined => {
  let p = url.pathname.replace(/\/$/, "");
  const isMarkdown = p.endsWith(".md");
  if (isMarkdown) p = p.slice(0, -".md".length);
  const target = REDIRECTS[p];
  if (!target) return undefined;
  if (isMarkdown) return `${target.split("#")[0]}.md`;
  return target;
};

export default {
  fetch: async (request: Request, env: WorkerEnv) => {
    const url = new URL(request.url);
    const canonical = url.host === CANONICAL_HOST;
    const redirect = resolveRedirect(url);
    if (redirect !== undefined) {
      return Response.redirect(new URL(redirect, request.url), 301);
    }
    if (url.pathname === "/robots.txt" && !canonical) {
      return new Response(MIRROR_ROBOTS_TXT, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-robots-tag": "noindex",
        },
      });
    }
    if (request.method === "GET" && prefersMarkdown(request)) {
      const mdUrl = toMarkdownUrl(url).toString();
      const res = await env.ASSETS.fetch(new Request(mdUrl, request));
      // Astro's asset server labels `.md` as `application/octet-stream`, which
      // agents treat as a binary download instead of rendering. Force the
      // correct text type + charset since this branch only ever serves markdown.
      if (res.status !== 404)
        return withoutIndexing(
          withContentType(res, "text/markdown; charset=utf-8"),
          url,
          canonical,
        );
    }
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === "GET") {
      const v1 = await resolveV1Fallback(url);
      if (v1 !== undefined) return Response.redirect(v1, 301);
    }
    return withoutIndexing(
      withUtf8Charset(
        await rewriteAgentTextOrigin(
          request,
          rewriteSocialCardHost(request, res),
        ),
      ),
      url,
      canonical,
    );
  },
};

/**
 * Served as `robots.txt` on every non-canonical host. Crawlable on purpose:
 * a `Disallow` would stop crawlers from ever seeing the `noindex` header, and
 * a blocked URL can still be indexed by URL alone. No `Sitemap:` line, so the
 * mirror never advertises itself.
 */
const MIRROR_ROBOTS_TXT = `# Mirror of https://${CANONICAL_HOST} — every response is noindex.
User-agent: *
Allow: /
`;

/**
 * Every page is mirrored as raw markdown (`/getting-started.md`, or the same
 * URL requested with `Accept: text/markdown`) for agents. Search engines crawl
 * those mirrors too and index them as separate documents — duplicating the HTML
 * page and surfacing raw MDX (`import { Tabs } from "@astrojs/starlight/..."`)
 * as the search result's snippet. `llms.txt` / `llms-full.txt` are the same
 * kind of agent-facing text.
 *
 * Keep them crawlable (so the directive is actually seen) but out of the index.
 * On a non-canonical host *everything* is noindex — the HTML included.
 */
const withoutIndexing = (
  res: Response,
  url: URL,
  canonicalHost: boolean,
): Response => {
  const ct = res.headers.get("content-type") ?? "";
  const agentText =
    url.pathname.endsWith(".md") ||
    ct.includes("text/markdown") ||
    ct.includes("text/plain");
  if (canonicalHost && !agentText) return res;
  const next = new Response(res.body, res);
  next.headers.set("x-robots-tag", "noindex");
  return next;
};

/**
 * v1-era URL that still resolves on the v1 docs host, or `undefined`. Only
 * consulted after production 404s, so the extra HEAD subrequest is confined
 * to dead links.
 */
const resolveV1Fallback = async (url: URL): Promise<string | undefined> => {
  const pathname = url.pathname.replace(/\/$/, "");
  if (pathname.endsWith(".md")) return undefined;
  if (!V1_PREFIXES.some((prefix) => `${pathname}/`.startsWith(prefix))) {
    return undefined;
  }
  const v1Path = pathname.startsWith("/docs/")
    ? pathname.slice("/docs".length)
    : pathname;
  const target = `${V1_ORIGIN}${v1Path}${url.search}`;
  try {
    const probe = await fetch(target, { method: "HEAD", redirect: "follow" });
    return probe.ok ? target : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `llms.txt` / `llms-full.txt` are generated at build time with absolute
 * canonical URLs, so a PR preview would hand agents an index that points back
 * at production. Rewrite the baked origin to the request's own origin — the
 * same treatment `rewriteSocialCardHost` gives the OG tags.
 */
const AGENT_TEXT_PATHS = new Set(["/llms.txt", "/llms-full.txt"]);

const rewriteAgentTextOrigin = async (
  request: Request,
  res: Response,
): Promise<Response> => {
  const reqUrl = new URL(request.url);
  if (
    !AGENT_TEXT_PATHS.has(reqUrl.pathname) ||
    reqUrl.host === CANONICAL_HOST ||
    !res.ok
  ) {
    return res;
  }
  const body = (await res.text()).replaceAll(
    `${CANONICAL_ORIGIN}/`,
    `${reqUrl.origin}/`,
  );
  return new Response(body, res);
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

/**
 * Astro bakes absolute URLs into `og:image`, `og:url`, and `twitter:image`
 * using the `site` config. Rewrite those to the request's host so each
 * deployment unfurls itself. `<link rel="canonical">` is deliberately NOT
 * rewritten — it must keep pointing at production on every mirror.
 */
const rewriteSocialCardHost = (request: Request, res: Response): Response => {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return res;
  const reqUrl = new URL(request.url);
  if (reqUrl.host === CANONICAL_HOST) return res;

  const content = {
    element(el: HTMLRewriterElement) {
      const value = el.getAttribute("content");
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
      el.setAttribute("content", u.toString());
    },
  };

  return new HTMLRewriter()
    .on('meta[property="og:image"]', content)
    .on('meta[property="og:url"]', content)
    .on('meta[name="twitter:image"]', content)
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
