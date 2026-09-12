import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

const SECRET = "s3cret-from-binding";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("server-renders the home page with platform.env", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#secret")).toHaveText(`secret:${SECRET}`);
      await expect(page.locator("#ctx")).toHaveText("ctx:yes");
      await expect(page.locator("#devalued")).toHaveText("devalued:{n:1}");
    });

    it("hydrates the client-interactive counter", async ({ page, server }) => {
      await page.goto(new URL("/counter", server.url).toString());
      await expect(page.locator("#count")).toHaveText("count:0");
      // wait for hydration before interacting (the effect flips the marker)
      await expect(page.locator("#increment")).toHaveAttribute("data-hydrated", "true");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:1");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:2");
    });

    it("serves the prerendered page", async ({ server }) => {
      const response = await server.fetch("/prerendered");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("this-page-is-prerendered");
    });

    it("serves static assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent: *");
    });

    it("runs the server endpoint (cookie, uuid, node:crypto, platform.env)", async ({ server }) => {
      const body = await server.fetchJson<{
        uuid: string;
        nodeUuid: string;
        cookie: string;
        secret: string;
      }>("/api/hello");
      expect(body.cookie).toBe("fixture=ok");
      expect(body.secret).toBe(SECRET);
      expect(body.uuid).toMatch(UUID_REGEX);
      expect(body.nodeUuid).toMatch(UUID_REGEX);
    });

    it("honors the user vite.config.ts (kit alias, user plugin, adapter override)", async ({
      server,
    }) => {
      // `$fixture` (a user kit alias) and `virtual:fixture-marker` (a user
      // Vite plugin) both live in the fixture's own vite.config.ts — this
      // endpoint only works when that file is loaded natively. The config
      // also declares a user adapter that THROWS from `adapt()`, so live
      // builds succeeding at all proves the deploy target's adapter replaced
      // it.
      const body = await server.fetchJson<{ marker: string; greeting: string }>("/api/user-config");
      expect(body.marker).toBe("user-vite-plugin-active");
      expect(body.greeting).toBe("greeting-via-user-alias");
    });

    it("runs a form action via progressive enhancement (no reload)", async ({ page, server }) => {
      await page.goto(new URL("/form", server.url).toString());
      await expect(page.locator("#form-result")).toHaveText("result:none");
      // wait for hydration, then plant a marker a full-page navigation would lose
      await expect(page.locator("#submit")).toHaveAttribute("data-hydrated", "true");
      await page.evaluate(() => {
        (window as { __enhanced?: boolean }).__enhanced = true;
      });
      await page.fill("#name", "playwright");
      await page.click("#submit");
      await expect(page.locator("#form-result")).toHaveText("result:hello playwright");
      await expect(page.locator("#form-secret")).toHaveText(`secret:${SECRET}`);
      const marker = await page.evaluate(() => (window as { __enhanced?: boolean }).__enhanced);
      expect(marker).toBe(true);
    });

    it("runs the form action without JavaScript (plain POST re-render)", async ({
      request,
      server,
    }) => {
      // a real HTTP POST (no client-side kit runtime involved), as a
      // JavaScript-less browser would submit it
      const response = await request.post(new URL("/form?/greet", server.url).toString(), {
        form: { name: "curl" },
        headers: {
          // kit's CSRF check requires a same-origin `origin` header on form
          // posts; `accept: text/html` selects the no-JS HTML re-render (kit
          // answers JSON for enhanced submissions)
          origin: server.url.origin,
          accept: "text/html",
        },
      });
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain("hello curl");
    });

    it("round-trips cookies through the +page.server load", async ({ page, server }) => {
      await page.goto(new URL("/cookies", server.url).toString());
      await expect(page.locator("#visits")).toHaveText("visits:1");
      await page.reload();
      await expect(page.locator("#visits")).toHaveText("visits:2");
      await page.reload();
      await expect(page.locator("#visits")).toHaveText("visits:3");
    });

    it("serves a binary endpoint response intact", async ({ server }) => {
      const response = await server.fetch("/api/binary");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("x-binary-length")).toBe("256");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(256);
      expect(bytes[0]).toBe(0);
      expect(bytes[128]).toBe(128);
      expect(bytes[255]).toBe(255);
    });

    it("serves a route-group page with layout data (group not in URL)", async ({
      page,
      server,
    }) => {
      const response = await page.goto(new URL("/about", server.url).toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#layout-section")).toHaveText("section:marketing");
      await expect(page.locator("#layout-secret")).toHaveText(`layout-secret:${SECRET}`);
      await expect(page.locator("#about-marker")).toHaveText("about-inside-group");
      // the group directory name itself is not routable
      const literal = await server.fetch("/(marketing)/about");
      expect(literal.status).toBe(404);
    });

    it("round-trips platform.caches (put on miss, hit on the second request)", async ({
      server,
    }) => {
      // a fresh key per invocation so retries never see a warm cache
      const key = crypto.randomUUID();
      type CacheProbe = { supported: boolean; cached: boolean; key: string };
      const first = await server.fetchJson<CacheProbe>(`/api/cache?key=${key}`);
      expect(first.supported).toBe(true);
      expect(first.cached).toBe(false);
      expect(first.key).toBe(key);
      const second = await server.fetchJson<CacheProbe>(`/api/cache?key=${key}`);
      expect(second.supported).toBe(true);
      // live runs on workerd with the real Cache API; dev serves `caches`
      // through cloudflare-runtime's platform proxy, which round-trips too
      // (unlike wrangler's no-op dev cache).
      expect(second.cached).toBe(true);
    });

    it("serves real bindings, env overrides, and cf through platform", async ({ page, server }) => {
      const response = await page.goto(new URL("/platform", server.url).toString());
      expect(response?.status()).toBe(200);
      // FIXTURE_KV is a real KV namespace binding — in dev the put/get pair
      // round-trips through the platform proxy's workerd instance
      await expect(page.locator("#kv")).toHaveText("kv:kv-round-trip");
      // FIXTURE_OVERRIDE: the dev `env` literal wins over the proxied Text
      // binding; live serves the binding value
      await expect(page.locator("#override")).toHaveText(
        mode === "dev" ? "override:literal-override" : "override:proxied-value",
      );
      // `cf` is populated in both modes (wrangler-parity mock in dev)
      await expect(page.locator("#cf")).toHaveText("cf-colo:present");
    });
  });
}
