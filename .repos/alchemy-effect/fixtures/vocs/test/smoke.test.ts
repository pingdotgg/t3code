import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("SSRs the homepage with the docs sidebar", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Vocs Fixture Home" })).toBeVisible();
      await expect(page.getByTestId("home-marker")).toHaveText("HOME_MARKER");
      // The docs shell (sidebar) is rendered by the worker at request time.
      const sidebar = page.getByRole("complementary");
      await expect(sidebar.getByRole("link", { name: "Guide" })).toBeVisible();
      await expect(sidebar.getByRole("link", { name: "Counter" })).toBeVisible();
    });

    it("navigates to a second page from the sidebar", async ({ page, server }) => {
      await page.goto(server.url.toString());
      await page.getByRole("complementary").getByRole("link", { name: "Guide" }).click();
      await page.waitForURL("**/guide");
      await expect(page.getByTestId("guide-marker")).toHaveText("GUIDE_MARKER");
    });

    it("hydrates the custom MDX React component", async ({ page, server }) => {
      await page.goto(new URL("/counter", server.url).toString());
      await expect(page.getByTestId("counter-page-marker")).toHaveText("COUNTER_PAGE_MARKER");
      const counter = page.getByTestId("counter");
      await expect(counter).toHaveText("count: 0");
      // The first click can land before hydration attaches the listener;
      // retry until the click observably increments.
      await expect(async () => {
        await counter.click();
        await expect(counter).toHaveText(/count: [1-9]\d*/, { timeout: 500 });
      }).toPass();
    });

    it("serves the static asset", async ({ server }) => {
      const response = await server.fetch("/hello.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello from public/");
    });
  });
}

// Build-time artifacts only exist in the production build: vocs prerenders
// llms.txt / llms-full.txt into dist/public, served by the assets layer.
test.describe("live artifacts", () => {
  const it = Playwright.make("live");

  it("serves the generated llms.txt from assets", async ({ server }) => {
    const response = await server.fetch("/llms.txt");
    expect(response.status).toBe(200);
  });
});
