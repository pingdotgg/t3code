import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

const MESSAGE = "hello-from-sveltekit-spa-binding";
/** Marker baked into `src/app.html` — present in any response that is the SPA shell. */
const SHELL_MARKER = "sveltekit-spa-shell";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    // Same Windows-runner socket-buffer exhaustion as the sibling sveltekit
    // fixture's gate (see fixtures/sveltekit/scripts/e2e.mjs for the full
    // evidence trail, incl. the failed port-range-widening experiment): the
    // live serve's miniflare loopback churn hits kernel AFD buffer limits
    // late in the suite and every fallback-dependent route 404s. Dev mode is
    // unaffected and stays covered on Windows.
    test.skip(
      mode === "live" && process.platform === "win32" && !!process.env.CI,
      "Windows CI runner socket-buffer exhaustion (see fixtures/sveltekit/scripts/e2e.mjs)",
    );
    const it = Playwright.make(mode);

    it("hydrates the home page (no SSR) and honors the user svelte config", async ({
      page,
      server,
    }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#home-title")).toHaveText("sveltekit-spa-home");
      await expect(page.locator("#hydrated")).toHaveText("hydrated:yes");
      // The user preprocess registered in vite.config.ts's `sveltekit(...)`
      // call (kit v3 forbids svelte.config.js) rewrote the literal — only
      // observable if the user's config file was loaded.
      await expect(page.locator("#svelte-config")).toHaveText("marker:svelte-config-loaded");
    });

    it("deep link to a client route serves the SPA shell, then hydrates the right view", async ({
      page,
      server,
    }) => {
      // Raw response: the app shell (fallback / CSR shell), NOT the widgets
      // markup — pages are ssr = false.
      const raw = await server.fetch("/widgets");
      expect(raw.status).toBe(200);
      const html = await raw.text();
      expect(html).toContain(SHELL_MARKER);
      expect(html).not.toContain("sprocket");

      // Browser: same deep link hydrates into the widgets view, whose
      // universal +page.ts load ran CLIENT-side and fetched the server-run
      // API endpoint.
      await page.goto(new URL("/widgets", server.url).toString());
      await expect(page.locator("#widgets-title")).toHaveText("sveltekit-spa-widgets");
      await expect(page.locator("#widgets-server")).toHaveText("server:yes");
      await expect(page.locator("#widgets-message")).toHaveText(`message:${MESSAGE}`);
      // `$spa/widgets` — user alias from vite.config.ts resolved.
      await expect(page.locator("#widgets-description")).toHaveText("widgets-via-user-alias:3");
      await expect(page.locator("#widgets-list li")).toHaveCount(3);
    });

    it("client-side routes between views without a full navigation", async ({ page, server }) => {
      await page.goto(server.url.toString());
      await expect(page.locator("#hydrated")).toHaveText("hydrated:yes");
      // Plant a marker a full-page navigation would lose.
      await page.evaluate(() => {
        (window as { __spa?: boolean }).__spa = true;
      });
      await page.click("#nav-about");
      await expect(page.locator("#about-title")).toHaveText("sveltekit-spa-about");
      await page.click("#nav-widgets");
      await expect(page.locator("#widgets-title")).toHaveText("sveltekit-spa-widgets");
      await expect(page.locator("#widgets-list li")).toHaveCount(3);
      expect(await page.evaluate(() => (window as { __spa?: boolean }).__spa)).toBe(true);
    });

    it("runs the API endpoint server-side despite ssr=false pages", async ({ server }) => {
      const body = await server.fetchJson<{
        server: boolean;
        message: string | null;
        widgets: Array<{ id: string; name: string }>;
      }>("/api/widgets");
      expect(body.server).toBe(true);
      // The Text binding is only reachable server-side — proves endpoints
      // execute in the worker (live) / kit's dev SSR (dev), not the browser.
      expect(body.message).toBe(MESSAGE);
      expect(body.widgets).toHaveLength(3);
    });

    it("serves static assets directly", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent: *");
    });

    it("serves the SPA fallback for unknown paths and renders the 404 view", async ({
      page,
      server,
    }) => {
      // not_found_handling: "single-page-application" — an unmatched path
      // must come back as the app shell (the adapter's generated
      // index.html fallback live; kit's CSR shell in dev), which then
      // hydrates into kit's client-side 404 error view.
      const raw = await server.fetch("/definitely/not/a/route");
      expect(await raw.text()).toContain(SHELL_MARKER);

      await page.goto(new URL("/definitely/not/a/route", server.url).toString());
      await expect(page.locator("#error-title")).toHaveText("spa-error:404");
    });
  });
}
