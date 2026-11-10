import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

const SECRET = "s3cret-from-binding";

// Both modes run the shared contract. Live serves the adapter-emitted
// `dist/server/worker.js` under miniflare (asset-first, SSR on miss); dev is
// Octane's own Vite dev server (the plugin's in-process SSR middleware).
for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("server-renders the home page", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("page-marker")).toHaveText("OCTANE_FIXTURE");
    });

    it("hydrates the client-interactive counter", async ({ page, server }) => {
      await page.goto(server.url.toString());
      await expect(page.locator("#count")).toHaveText("count:0");
      // wait for hydration before interacting (useEffect flips the marker)
      await expect(page.locator("#increment")).toHaveAttribute("data-hydrated", "true");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:1");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:2");
    });

    it("serves static assets asset-first", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent: *");
    });

    it("runs the server route", async ({ server }) => {
      const body = await server.fetchJson<{
        marker: string;
        secret: string | null;
        hasWaitUntil: boolean;
      }>("/api/hello");
      expect(body.marker).toBe("api-route-ok");
      if (mode === "live") {
        // `context.platform` is the adapter-forwarded `{ env, ctx }`.
        expect(body.secret).toBe(SECRET);
        expect(body.hasWaitUntil).toBe(true);
      } else {
        // Octane's dev middleware supplies no platform (upstream
        // limitation) — the handler degrades to null/false.
        expect(body.secret).toBeNull();
        expect(body.hasWaitUntil).toBe(false);
      }
    });
  });
}
