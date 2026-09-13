import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const method of Playwright.SERVER_METHODS) {
  test.describe(method, () => {
    const it = Playwright.make(method);

    it("server-renders the homepage markup", async ({ server }) => {
      // Raw fetch, no JS: the page content (including the counter's initial
      // state) must already be in the server-rendered HTML.
      const response = await server.fetch("/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Hello world!");
      // The counter's SSR markup — solid's hydration markers split the text
      // ("Clicks: <!--...-->0"), so match the label and the button class.
      expect(html).toContain("Clicks:");
      expect(html).toContain('class="increment"');
    });

    it("renders the homepage", async ({ page, server }) => {
      const response = await page
        .goto(server.url.toString())
        .then(async (response) => {
          // solidstart has a bug where the first request is not always successful in dev mode.
          // Retry the request if it is not successful as a temporary workaround.
          if (response?.ok()) return response;
          return page.goto(server.url.toString());
        });
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      // Hydration: the SSR'd counter button responds to clicks.
      expect(await page.textContent("button.increment")).toBe("Clicks: 0");
      await page.click("button.increment");
      expect(await page.textContent("button.increment")).toBe("Clicks: 1");

      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("about.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });
    });

    it("serves a direct navigation to /about (SSR)", async ({
      page,
      server,
    }) => {
      // Raw fetch: the about markup is server-rendered.
      const raw = await server.fetch("/about");
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain(">About</h1>");

      // Hard browser navigation straight to the route.
      const response = await page.goto(
        new URL("/about", server.url).toString(),
      );
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1")).toHaveText("About");
    });

    it("renders the [...404] route for unmatched paths", async ({
      page,
      server,
    }) => {
      // The [...404].tsx catch-all renders server-side. NOTE: despite the
      // route's <HttpStatusCode code={404} />, SolidStart 2.0.0-alpha.3's
      // streaming response commits status 200 in both modes (observed live
      // and dev), so this asserts the route's markup, not the status code.
      const raw = await server.fetch("/definitely/not/a/route");
      expect(await raw.text()).toContain("Page Not Found");

      await page.goto(
        new URL("/definitely/not/a/route", server.url).toString(),
      );
      await expect(page.locator("h1")).toHaveText("Page Not Found");
    });

    it("serves static assets from public/", async ({ server }) => {
      const response = await server.fetch("/favicon.ico");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image");
    });

    it("runs the API route server-side (GET)", async ({ server }) => {
      const body = await server.fetchJson<{ method: string; server: boolean }>(
        "/api/echo",
      );
      expect(body).toMatchObject({ method: "GET", server: true });
    });

    it("round-trips a POST through the API route", async ({ server }) => {
      // Plain HTTP (not `server.fetch`): the live-mode dispatchFetch wrapper
      // in the harness drops the RequestInit, losing POST bodies (see the
      // same pattern in fixtures/waku/test/smoke.test.ts). Both modes listen
      // on a real socket, so this exercises the same worker path.
      const response = await fetch(new URL("/api/echo", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ping: "pong" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        method: "POST",
        echoed: { ping: "pong" },
      });
    });
  });
}
