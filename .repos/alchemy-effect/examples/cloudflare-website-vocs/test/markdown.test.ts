import { expect, test } from "bun:test";

// Run against alchemy dev or a deployed Cloudflare site:
// VOCS_URL=http://localhost:1337 bun test test/markdown.test.ts
// TODO(upstream Vocs): support Markdown on Cloudflare without patching internal
// middleware. Dev needs host-side compilation; production needs asset-binding
// access and content negotiation before static HTML. No upstream issue filed yet.
const url = process.env.VOCS_URL;

(url ? test.failing : test.skip)(
  "TODO upstream: Cloudflare Vocs serves negotiated Markdown",
  async () => {
    const response = await fetch(new URL("/guide", url), {
      headers: { accept: "text/markdown" },
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toContain("# Deployment guide");
  },
  20_000,
);
