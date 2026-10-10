import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

/** Marker baked into `index.html` — present in any response that is the SPA shell. */
const SHELL_MARKER = "solid-spa-shell";

for (const method of Playwright.SERVER_METHODS) {
  test.describe(method, () => {
    const it = Playwright.make(method);

    it("renders the homepage", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      expect(await page.textContent("output")).toBe("Count: 0");
      await page.click("button:has-text('+')");
      expect(await page.textContent("output")).toBe("Count: 1");

      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("about.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });
    });

    it("deep link to a client route serves the SPA shell, then hydrates the right view", async ({
      page,
      server,
    }) => {
      // Raw response: the app shell (not_found_handling:
      // "single-page-application" live; Vite's SPA fallback in dev) — a
      // client-only app has no /about asset, so the shell must come back.
      const raw = await server.fetch("/about");
      expect(raw.status).toBe(200);
      const html = await raw.text();
      expect(html).toContain(SHELL_MARKER);
      // The shell is not pre-rendered: no route content in the raw HTML.
      expect(html).not.toContain("A page all about this website");

      // Browser: the same deep link hydrates into the About view.
      await page.goto(new URL("/about", server.url).toString());
      await expect(page.locator("h1")).toHaveText("About");
      await expect(page.locator("main")).toContainText(
        "A page all about this website",
      );
    });

    it("serves the SPA shell (200) for a raw fetch of an unknown path", async ({
      page,
      server,
    }) => {
      const raw = await server.fetch("/definitely/not/a/route");
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain(SHELL_MARKER);

      // The shell hydrates into the router's catch-all 404 view.
      await page.goto(
        new URL("/definitely/not/a/route", server.url).toString(),
      );
      await expect(page.locator("h1")).toHaveText("404: Not Found");
    });

    it("client-side routes between views without a full navigation", async ({
      page,
      server,
    }) => {
      await page.goto(server.url.toString());
      await expect(page.locator("h1")).toHaveText("Home");
      // Plant a marker a full-page navigation would lose.
      await page.evaluate(() => {
        (window as { __spa?: boolean }).__spa = true;
      });
      await page.click("a[href='/about']");
      await expect(page.locator("h1")).toHaveText("About");
      await page.click("a[href='/']");
      await expect(page.locator("h1")).toHaveText("Home");
      expect(
        await page.evaluate(() => (window as { __spa?: boolean }).__spa),
      ).toBe(true);
    });

    it("serves static assets directly", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent: *");
    });
  });
}
