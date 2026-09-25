import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

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

      expect(await page.textContent("button.counter")).toBe("Count is 0");
      await page.click("button.counter");
      expect(await page.textContent("button.counter")).toBe("Count is 1");
    });

    it("routes unmatched paths to the worker API route", async ({ server }) => {
      // No static asset matches /api/hello, so the request falls through to
      // the user worker (src/server.ts wired via `main`).
      const body = await server.fetchJson<{ message: string; source: string }>(
        "/api/hello",
      );
      expect(body).toMatchObject({ message: "Hello World", source: "worker" });
    });

    it("still serves static assets ahead of the worker", async ({ server }) => {
      const response = await server.fetch("/favicon.svg");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<svg");
    });

    it("returns the worker's 404 for unknown paths (not_found_handling: none)", async ({
      server,
    }) => {
      // not_found_handling: "none" — the asset layer never falls back to a
      // 404 page or SPA shell; the unmatched request reaches the worker,
      // which owns the 404.
      const response = await server.fetch("/definitely/not/a/route");
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });
  });
}
