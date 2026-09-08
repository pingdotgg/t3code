import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

const FIXTURE_VALUE = "hello-from-astro-ssr-binding";

// This suite exercises the user-config wave's behavior
// (fixtures/astro-ssr/astro.config.mjs honored by the integration).
for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("renders the SSR page per request: binding + fresh request id", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#mode")).toHaveText("on-demand");
      await expect(page.locator("#binding")).toHaveText(FIXTURE_VALUE);

      // Per-request rendering: two requests must carry different
      // middleware-stamped request ids.
      const firstId = await page.locator("#request-id").textContent();
      expect(firstId).toBeTruthy();
      expect(firstId).not.toBe("missing");
      await page.reload();
      const secondId = await page.locator("#request-id").textContent();
      expect(secondId).toBeTruthy();
      expect(secondId).not.toBe(firstId);
    });

    it("renders dynamic param routes on demand", async ({ server }) => {
      const first = await server.fetch("/greet/world");
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("Hello, world!");

      // No getStaticPaths: any param renders — the defining SSR behavior.
      const second = await server.fetch("/greet/another-visitor");
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("Hello, another-visitor!");
    });

    it("handles a form POST server-side (browser submission)", async ({ page, server }) => {
      await page.goto(new URL("/feedback", server.url).toString());
      await expect(page.locator("#feedback-result")).toHaveCount(0);
      await page.locator("#message").fill("hello from playwright");
      await page.locator("#submit").click();
      await expect(page.locator("#feedback-result")).toHaveText("received: hello from playwright");
    });

    it("handles a direct form POST (checkOrigin: false from the user config)", async ({
      server,
    }) => {
      // Plain HTTP against the listening URL in both modes — the live
      // server's dispatchFetch helper does not forward request init. No
      // Origin header is sent: this passing proves the user config's
      // `security.checkOrigin: false` is honored (the default would 403).
      const response = await fetch(new URL("/feedback", server.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ message: "direct-post" }).toString(),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("received: direct-post");
    });

    it("round-trips Astro.session across requests (zero-config sessions)", async ({ server }) => {
      const first = await fetch(new URL("/session", server.url));
      expect(first.status).toBe(200);
      expect(await first.text()).toContain('<p id="count">1</p>');
      const setCookie = first.headers.get("set-cookie");
      expect(setCookie).toBeTruthy();
      const cookie = setCookie!.split(";")[0]!;
      const second = await fetch(new URL("/session", server.url), {
        headers: { cookie },
      });
      expect(second.status).toBe(200);
      expect(await second.text()).toContain('<p id="count">2</p>');
    });

    it("renders the streaming page (early + late chunks)", async ({ server }) => {
      const response = await server.fetch("/stream");
      expect(response.status).toBe(200);
      const html = await response.text();
      const early = html.indexOf('id="early"');
      const late = html.indexOf('id="late"');
      expect(early).toBeGreaterThan(-1);
      expect(late).toBeGreaterThan(early);
    });

    it("serves the single prerendered exception (hybrid)", async ({ server }) => {
      const response = await server.fetch("/about/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('id="mode"');
      expect(html).toContain("prerendered");
    });

    it("reads the binding from the JSON API route", async ({ server }) => {
      const json = await server.fetchJson<{ value: string | null; hasAssetsBinding: boolean }>(
        "/api/hello",
      );
      expect(json).toMatchObject({ value: FIXTURE_VALUE, hasAssetsBinding: true });
    });

    it("echoes a JSON POST body through the API route", async ({ server }) => {
      const response = await fetch(new URL("/api/hello", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ping: "pong" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ echoed: { ping: "pong" }, method: "POST" });
    });

    it("returns binary data from an endpoint", async ({ server }) => {
      const response = await server.fetch("/api/binary");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04, 0x05, 0x06, 0x07,
      ]);
      expect(response.headers.get("x-binary-length")).toBe(String(bytes.length));
    });

    it("runs middleware on on-demand routes: locals + response headers", async ({ server }) => {
      const response = await server.fetch("/greet/middleware-check");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware")).toBe("hit");
      const requestId = response.headers.get("x-request-id");
      expect(requestId).toBeTruthy();
      // The header mirrors the locals value rendered into the page body.
      expect(await response.text()).toContain(requestId!);
    });

    it("serves the redirect declared in astro.config.mjs", async ({ server }) => {
      // The redirect target (/greet/astro) is an on-demand route, so the
      // redirect must be handled dynamically by the worker in BOTH modes —
      // there is no prerendered target for the asset layer to serve.
      const response = await fetch(new URL("/legacy-greeting", server.url), {
        redirect: "manual",
      });
      expect([301, 302, 308]).toContain(response.status);
      expect(response.headers.get("location")).toContain("/greet/astro");

      const followed = await fetch(new URL("/legacy-greeting", server.url));
      expect(followed.status).toBe(200);
      expect(await followed.text()).toContain("Hello, astro!");
    });

    it("serves public assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent");
    });

    it("returns 404 for unmatched routes", async ({ server }) => {
      const response = await server.fetch("/definitely-not-a-route");
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    });
  });
}
