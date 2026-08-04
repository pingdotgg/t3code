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
 * using the `site` config (`https://alchemy.run`). PR previews and
 * custom domains then advertise OG / canonical URLs that point back at
 * the canonical host — so a Slack/Twitter unfurl of a preview URL
 * fetches the *production* card, not the one for the page being
 * shared.
 *
 * Rewrite those tags at the edge to match the request's actual host so
 * each deployment unfurls itself.
 */
const CANONICAL_HOST = "alchemy.run";

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
    "/cloudflare/compute/workers#schemaless-rpc",
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
  "/concepts/platform": "/infrastructure-as-effects/functions-and-servers",
  "/infrastructure-as-effects/platform":
    "/infrastructure-as-effects/functions-and-servers",
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
  "/neon/branching": "/neon/data/branching",
  "/neon/connections": "/neon/data/connections",
  "/neon/migrations": "/neon/data/migrations",
  "/planetscale/backups": "/planetscale/data/backups",
  "/planetscale/credentials": "/planetscale/data/credentials",
  "/planetscale/migrations": "/planetscale/data/migrations",
  "/planetscale/mysql": "/planetscale/data/mysql",
  "/planetscale/postgres": "/planetscale/data/postgres",
  "/integrations": "/providers",
  "/integrations/planetscale": "/planetscale",
  "/integrations/neon": "/neon",
  "/integrations/axiom": "/axiom",
  "/integrations/github": "/github",
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
    const redirect = resolveRedirect(new URL(request.url));
    if (redirect !== undefined) {
      return Response.redirect(new URL(redirect, request.url), 301);
    }
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
    return withUtf8Charset(
      await rewriteLlmsTxtOrigin(request, rewriteCanonicalHost(request, res)),
    );
  },
};

/**
 * `llms.txt` / `llms-full.txt` are generated at build time with absolute
 * canonical URLs, so a PR preview would hand agents an index that points back
 * at production. Rewrite the baked origin to the request's own origin — the
 * same treatment `rewriteCanonicalHost` gives HTML meta tags.
 */
const rewriteLlmsTxtOrigin = async (
  request: Request,
  res: Response,
): Promise<Response> => {
  const reqUrl = new URL(request.url);
  if (
    (reqUrl.pathname !== "/llms.txt" && reqUrl.pathname !== "/llms-full.txt") ||
    reqUrl.host === CANONICAL_HOST ||
    !res.ok
  ) {
    return res;
  }
  const body = (await res.text()).replaceAll(
    `https://${CANONICAL_HOST}/`,
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
