import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

/**
 * Requests target the server's real socket URL (not miniflare's
 * `dispatchFetch("http://localhost/…")` helper): production requests always
 * carry a real host:port, and OpenNext's middleware-rewrite handling
 * re-fetches the rewritten absolute URL — a port-less `localhost` host would
 * send that loopback fetch to port 80.
 */
const get = (server: { url: URL }, path: string) => fetch(new URL(path, server.url));

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("renders the SSR page", async ({ server }) => {
      const response = await get(server, "/");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("fixtures-nextjs SSR page");
      expect(body).toContain("rendered-at:");
    });

    it("serves the API route with the middleware header", async ({ server }) => {
      const response = await get(server, "/api/hello");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-fixture-middleware")).toBe("passed");
      const json = (await response.json()) as { hello: string };
      expect(json.hello).toBe("world");
    });

    it("rewrites via middleware", async ({ server }) => {
      const response = await get(server, "/mw-rewrite");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { hello: string; url: string };
      expect(json.hello).toBe("world");
      expect(json.url).toContain("/api/hello");
    });

    it("reads a Text binding through getCloudflareContext", async ({ server }) => {
      const response = await get(server, "/api/binding");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { value: string | null };
      expect(json.value).toBe("hello-from-binding");
    });

    it("serves the ISR page from the prerendered cache", async ({ server }) => {
      const first = await get(server, "/isr");
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      const firstStamp = firstBody.match(/isr-rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
      expect(firstStamp).toBeDefined();

      // The prerendered payload serves as-is: repeated hits inside the
      // revalidate window return the same build-time stamp.
      const second = await get(server, "/isr");
      expect(second.status).toBe(200);
      const secondBody = await second.text();
      const secondStamp = secondBody.match(/isr-rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
      expect(secondStamp).toBe(firstStamp);
    });

    it("serves public/ static assets", async ({ server }) => {
      const response = await get(server, "/static.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello from a static asset");
    });

    it("serves _next/static client chunks", async ({ server }) => {
      const html = await (await get(server, "/")).text();
      const chunk = html.match(/\/_next\/static\/[^"'\s\\]+\.js/)?.[0];
      expect(chunk).toBeDefined();
      const response = await get(server, chunk!);
      expect(response.status).toBe(200);
    });

    it("hydrates the client-interactive page", async ({ page, server }) => {
      await page.goto(new URL("/counter", server.url.toString()).toString());
      await expect(page.getByTestId("count")).toHaveText("count:0");
      await page.getByTestId("increment").click();
      await expect(page.getByTestId("count")).toHaveText("count:1");
      await page.getByTestId("increment").click();
      await expect(page.getByTestId("count")).toHaveText("count:2");
    });

    it("serves a prerendered dynamic segment (generateStaticParams)", async ({ server }) => {
      const response = await get(server, "/products/alpha");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("PRODUCT_PAGE_MARKER");
      expect(body).toMatch(/product-slug:(?:<!-- -->)?alpha/);
    });

    it("renders a non-prerendered dynamic segment on demand", async ({ server }) => {
      const response = await get(server, "/products/gamma");
      expect(response.status).toBe(200);
      expect(await response.text()).toMatch(/product-slug:(?:<!-- -->)?gamma/);
    });

    it("renders a catch-all dynamic segment", async ({ server }) => {
      const response = await get(server, "/docs/guides/deploy/workers");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("DOCS_CATCHALL_MARKER");
      expect(body).toMatch(/docs-path:(?:<!-- -->)?guides\/deploy\/workers/);
    });

    it("mutates a KV binding through a server action form", async ({ page, server }) => {
      const name = `visitor-${Date.now()}`;
      await page.goto(new URL("/guestbook", server.url.toString()).toString());
      await expect(page.locator("h1")).toHaveText("GUESTBOOK_MARKER");
      await page.locator('input[name="name"]').fill(name);
      await page.locator('button[type="submit"]').click();
      // The action writes to FIXTURE_KV and revalidates; the page re-renders
      // with the latest entry read back from KV.
      await expect(page.locator("main")).toContainText(`guestbook-latest:${name}`);
    });

    it("streams the Suspense shell before the resolved content", async ({ server }) => {
      // `accept-encoding: identity`: the local live (miniflare) serving path
      // buffers gzip bodies to completion, which would hide the progressive
      // flush this test asserts. Production Cloudflare streams gzip fine.
      const response = await fetch(new URL("/streaming", server.url), {
        headers: { "accept-encoding": "identity" },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let sawShellFirst = false;
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (
          !sawShellFirst &&
          buffer.includes("STREAMING_SUSPENSE_MARKER") &&
          !buffer.includes("STREAMING_RESOLVED_MARKER")
        ) {
          // The shell (with the fallback) flushed before the slow segment.
          sawShellFirst = true;
        }
      }
      expect(sawShellFirst).toBe(true);
      expect(buffer).toContain("STREAMING_RESOLVED_MARKER");
    });

    it("serves the custom not-found boundary for unmatched routes", async ({ server }) => {
      const response = await get(server, "/definitely/not/a/route");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("CUSTOM_NOT_FOUND_MARKER");
    });

    it("serves the custom not-found boundary from notFound()", async ({ server }) => {
      const response = await get(server, "/gone");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("CUSTOM_NOT_FOUND_MARKER");
    });

    it("renders the segment error boundary after a server render throws", async ({
      page,
      server,
    }) => {
      await page.goto(new URL("/boom", server.url.toString()).toString());
      await expect(page.locator("h1")).toHaveText("ERROR_BOUNDARY_MARKER");
    });

    it("applies next.config redirects", async ({ server }) => {
      const response = await fetch(new URL("/old-home", server.url), {
        redirect: "manual",
      });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toContain("/");
    });

    it("applies next.config rewrites", async ({ server }) => {
      const response = await get(server, "/rewritten-hello");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { hello: string };
      expect(json.hello).toBe("world");
    });

    it("applies next.config headers", async ({ server }) => {
      const response = await get(server, "/api/hello");
      expect(response.headers.get("x-fixture-config-header")).toBe("from-next-config");
    });

    it("serves a Pages Router page with getServerSideProps", async ({ server }) => {
      const response = await get(server, "/legacy");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("PAGES_ROUTER_MARKER");
      expect(body).toMatch(/legacy-stamp:(?:<!-- -->)?pages-router-ssr/);
    });

    it("serves a Pages Router API route", async ({ server }) => {
      const response = await get(server, "/api/legacy");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { legacy: string };
      expect(json.legacy).toBe("pages-api");
    });
  });
}
