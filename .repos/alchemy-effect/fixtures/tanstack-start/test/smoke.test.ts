import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("server-renders the homepage markup", async ({ server }) => {
      // Raw fetch, no JS: the hero copy must already be in the HTML the
      // worker streamed (SSR), not injected after hydration.
      const response = await server.fetch("/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Start simple, ship quickly.");
      expect(html).toContain("TanStack Start Starter");
    });

    it("renders the homepage", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
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
    });

    it("hydrates: the theme toggle mutates the document theme", async ({
      page,
      server,
    }) => {
      await page.goto(server.url.toString());
      const toggle = page.getByRole("button", { name: /Theme mode/ });
      // The client effect ran (SSR renders "Auto" and hydration keeps it
      // until clicked).
      await expect(toggle).toHaveText("Auto");
      // In dev the click can land before hydration attaches the handler —
      // retry, but only click while the toggle still reads "Auto" so a
      // registered-but-slow click never advances the cycle twice.
      await expect(async () => {
        if ((await toggle.textContent()) === "Auto") {
          await toggle.click();
        }
        await expect(toggle).toHaveText("Light", { timeout: 500 });
      }).toPass({ timeout: 15_000 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });

    it("serves a direct navigation to /about (SSR)", async ({
      page,
      server,
    }) => {
      // Raw fetch: the about copy is server-rendered.
      const raw = await server.fetch("/about");
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain("A small starter with room to grow.");

      // Hard browser navigation straight to the route (no client-side
      // transition from /).
      const response = await page.goto(
        new URL("/about", server.url).toString(),
      );
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1")).toHaveText(
        "A small starter with room to grow.",
      );
    });

    it("serves static assets", async ({ server }) => {
      // Assets-first routing (`runWorkerFirst` unset, preview
      // `invoke_user_worker_ahead_of_assets: false`) — static files are
      // answered by the asset layer without invoking the worker.
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent");
    });

    it("returns 404 for an unmatched route", async ({ server }) => {
      const response = await server.fetch("/definitely/not/a/route");
      expect(response.status).toBe(404);
    });

    // Gated on the `TEST_POSTGRES_URL` secret (wired in ci.yml + turbo.json's
    // root `test` env list). CI asserts the secret is present, so this can
    // only skip in local runs without the secret — never silently on CI.
    const skipIfNoDatabase = process.env.TEST_POSTGRES_URL ? it : it.skip;
    skipIfNoDatabase("fetches database", async ({ server }) => {
      const response =
        await server.fetchJson<[{ "?column?": number }]>("/api/db");
      expect(response).toMatchObject([{ "?column?": 1 }]);
    });

    it("fetches WASM", async ({ server }) => {
      const response = await server.fetchJson<{ result: number }>("/api/wasm");
      expect(response).toMatchObject({ result: 3 });
    });
  });
}
