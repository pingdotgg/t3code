import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const method of Playwright.SERVER_METHODS) {
  test.describe(method, () => {
    const it = Playwright.make(method);

    it("server-renders the home page markup (RSC -> SSR)", async ({
      server,
    }) => {
      // Raw fetch, no JS: the worker runs the `rsc` environment and renders
      // HTML through the `ssr` environment — the server-component copy must
      // already be in the payload.
      const response = await server.fetch("/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<h1>Home</h1>");
      expect(html).toContain("rendered as a React Server Component");
    });

    it("renders the homepage and hydrates client routes", async ({
      page,
      server,
    }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("about.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      expect(await page.textContent("button.counter")).toBe("Count is 0");
      await page.click("button.counter");
      expect(await page.textContent("button.counter")).toBe("Count is 1");
    });

    it("serves a direct navigation to /about and hydrates the client component", async ({
      page,
      server,
    }) => {
      // Raw fetch: the "use client" about route is still server-rendered
      // through the rsc/ssr topology.
      const raw = await server.fetch("/about");
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain("rendered as a client component");

      // Hard browser navigation straight to the route (no client-side
      // transition from /) — the client component must hydrate.
      const response = await page.goto(
        new URL("/about", server.url).toString(),
      );
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1")).toHaveText("About");
      const counter = page.locator("button.counter");
      await expect(counter).toHaveText("Count is 0");
      // A click can land before hydration attaches the handler on a direct
      // navigation (observed in dev mode) — retry click-and-observe until
      // the component is interactive.
      await expect(async () => {
        await counter.click();
        await expect(counter).not.toHaveText("Count is 0", { timeout: 250 });
      }).toPass();
      await expect(counter).toHaveText(/Count is [1-9]\d*/);
    });

    it("returns 404 for an unmatched route", async ({ server }) => {
      // No catch-all route is configured: react-router's default error
      // boundary renders with a 404 status.
      const response = await server.fetch("/definitely/not/a/route");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("404 Not Found");
    });
  });
}
