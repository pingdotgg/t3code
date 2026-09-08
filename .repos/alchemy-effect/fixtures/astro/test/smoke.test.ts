import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

const FIXTURE_VALUE = "hello-from-astro-binding";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("renders the SSR page with the binding and hydrates the client script", async ({
      page,
      server,
    }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#mode")).toHaveText("on-demand");
      await expect(page.locator("#binding")).toHaveText(FIXTURE_VALUE);
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      const button = page.locator("#counter");
      await expect(button).toHaveText("count is 0");
      await button.click();
      await expect(button).toHaveText("count is 1");
    });

    it("serves the prerendered page", async ({ server }) => {
      const response = await server.fetch("/about/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('id="mode"');
      expect(html).toContain("prerendered");
    });

    it("prerenders inside workerd: top-level cloudflare:workers import + binding", async ({
      server,
    }) => {
      // The page is impossible under node prerendering (top-level
      // `cloudflare:workers` import); the baked binding value proves the
      // workerd prerenderer ran with the worker's bindings attached.
      const response = await server.fetch("/prerendered-env/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("prerendered-workerd");
      expect(html).toContain(FIXTURE_VALUE);
    });

    it("reads the binding from the API route", async ({ server }) => {
      const json = await server.fetchJson<{ value: string | null; hasAssetsBinding: boolean }>(
        "/api/hello",
      );
      expect(json).toMatchObject({ value: FIXTURE_VALUE, hasAssetsBinding: true });
    });

    it("honors astro.config.mjs: user integration route + user vite define", async ({ server }) => {
      // The /user-integration route only exists because the user's own
      // astro.config.mjs was loaded natively: a user integration injects it,
      // and the page renders a value produced by the file's `vite.define`.
      const response = await server.fetch("/user-integration");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("injected-by-user-integration");
      expect(html).toContain("hello-from-user-vite-define");
    });

    it("runs middleware: locals + response-header mutation", async ({ server }) => {
      const response = await server.fetch("/locals");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware")).toBe("hit");
      expect(await response.text()).toContain("set-by-middleware");
    });

    it("serves the configured redirect", async ({ server }) => {
      if (mode === "dev") {
        // Dev fetch forwards the init: observe the raw 3xx + location.
        const response = await server.fetch("/old-about", { redirect: "manual" });
        expect([301, 302, 308]).toContain(response.status);
        expect(response.headers.get("location")).toContain("/about");
      } else {
        // The live server's fetch (miniflare dispatchFetch) does not forward
        // the init, so assert the redirect end-to-end: following /old-about
        // lands on the prerendered about page.
        const response = await server.fetch("/old-about");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain('id="mode"');
        expect(html).toContain("prerendered");
      }
    });

    it("returns binary data from an endpoint", async ({ server }) => {
      const response = await server.fetch("/api/binary");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
      ]);
      expect(response.headers.get("x-binary-length")).toBe(String(bytes.length));
    });

    it("serves the content-collection-driven prerendered page", async ({ server }) => {
      const response = await server.fetch("/posts/hello-world/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('id="post-title"');
      expect(html).toContain("Hello World");
      expect(html).toContain("content-collection body");
    });

    it("round-trips Astro.session across requests (zero-config sessions)", async ({ server }) => {
      // Plain HTTP against the listening URL in both modes — the live
      // server's dispatchFetch helper does not forward request init.
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

    if (mode === "live") {
      it("emits _redirects and serves the redirect from the asset layer", async ({ server }) => {
        const content = await readFile(path.join(process.cwd(), "dist/client/_redirects"), "utf-8");
        expect(content).toMatch(/\/old-about\s+\/about\/\s+301/);
        const response = await fetch(new URL("/old-about", server.url), {
          redirect: "manual",
        });
        expect([301, 302, 308]).toContain(response.status);
        expect(response.headers.get("location")).toContain("/about");
      });

      it("emits _headers and serves hashed assets with immutable Cache-Control", async ({
        server,
      }) => {
        const content = await readFile(path.join(process.cwd(), "dist/client/_headers"), "utf-8");
        expect(content).toContain("/_astro/*");
        expect(content).toContain("Cache-Control: public, max-age=31536000, immutable");
        const assets = await readdir(path.join(process.cwd(), "dist/client/_astro"));
        expect(assets.length).toBeGreaterThan(0);
        const response = await fetch(new URL(`/_astro/${assets[0]}`, server.url));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        await response.arrayBuffer();
      });
    }

    it("serves public assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent");
    });

    it("falls back through ASSETS to the 404 page", async ({ server }) => {
      const response = await server.fetch("/definitely-not-a-route");
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    });
  });
}
