import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("SSR renders the dynamic page with the Text binding", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("page-marker")).toHaveText("PAGE_MARKER");
      await expect(page.getByTestId("layout-marker")).toHaveText("LAYOUT_MARKER");
      // Read at request time from `cloudflare:workers` env — proves the rsc
      // environment runs against the worker runtime in both modes.
      await expect(page.getByTestId("env-message")).toHaveText("MESSAGE=hello-from-binding");
    });

    it("hydrates the client component", async ({ page, server }) => {
      await page.goto(server.url.toString());
      const counter = page.getByTestId("counter");
      await expect(counter).toHaveText("count: 0");
      // The first click can land before hydration attaches the listener;
      // retry until the click observably increments.
      await expect(async () => {
        await counter.click();
        await expect(counter).toHaveText(/count: [1-9]\d*/, { timeout: 500 });
      }).toPass();
    });

    it("client-navigates to the static page", async ({ page, server }) => {
      await page.goto(server.url.toString());
      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await expect(page.getByTestId("about-marker")).toHaveText("ABOUT_STATIC_MARKER");
    });

    it("serves the static asset", async ({ server }) => {
      const response = await server.fetch("/hello.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello from public/");
    });

    it("round-trips a server action (form mutation) through the worker", async ({
      page,
      server,
    }) => {
      await page.goto(server.url.toString());
      await page.fill("[data-testid=greet-name]", "Waku");
      // The submit can land before hydration attaches the action; retry
      // until the round-trip observably completes. The MESSAGE suffix proves
      // the action executed inside the worker runtime with bindings.
      await expect(async () => {
        await page.click("[data-testid=greet-submit]");
        await expect(page.getByTestId("greet-output")).toHaveText(
          "Hello, Waku! MESSAGE=hello-from-binding",
          { timeout: 1_000 },
        );
      }).toPass();
    });

    it("SSRs the dynamic route with a path param", async ({ page, server }) => {
      const response = await page.goto(new URL("/items/42", server.url).toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("item-marker")).toHaveText("ITEM_MARKER id=42");
      await expect(page.getByTestId("item-env")).toHaveText("MESSAGE=hello-from-binding");
    });

    it("serves the API route (GET) from the worker", async ({ server }) => {
      const response = await server.fetch("/echo");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: "hello-from-binding" });
    });

    it("round-trips a POST through the API route", async ({ server }) => {
      // Plain HTTP (not `server.fetch`): the live-mode dispatchFetch wrapper
      // in the harness currently drops the RequestInit, losing POST bodies
      // (packages/cloudflare-test-tools/src/miniflare/miniflare.ts `fetch(path)` has no init
      // parameter). Both modes listen on a real socket, so this exercises
      // the same worker path.
      const response = await fetch(new URL("/echo", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ping: "pong" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        echoed: { ping: "pong" },
        message: "hello-from-binding",
      });
    });

    it("runs the src/middleware header middleware on worker responses", async ({ server }) => {
      // "/" is dynamic, so it always goes through the worker (in live mode
      // static assets bypass the middleware by design).
      const response = await server.fetch("/");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-waku-middleware")).toBe("fixtures-waku");
    });

    it("serves the page with a top-level cloudflare:workers import", async ({ page, server }) => {
      const response = await page.goto(new URL("/ssg-env", server.url).toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("ssg-env-marker")).toHaveText("SSG_ENV_MARKER");
      await expect(page.getByTestId("ssg-env-message")).toHaveText("MESSAGE=hello-from-binding");
    });

    it("honors waku.config.ts (user vite plugin's virtual module)", async ({ page, server }) => {
      // The page imports `virtual:fixtures-waku/user-config-marker`, served
      // by a USER vite plugin declared in waku.config.ts — it renders only
      // when the integration loads the user's config file natively and
      // merges its own plugins over it instead of replacing the file.
      const response = await page.goto(new URL("/config-marker", server.url).toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("config-marker")).toHaveText("hello-from-waku-config");
    });

    it("keeps layout client state across client navigation", async ({ page, server }) => {
      await page.goto(server.url.toString());
      const counter = page.getByTestId("nav-counter");
      await expect(counter).toHaveText("nav-count: 0");
      await expect(async () => {
        await counter.click();
        await expect(counter).toHaveText(/nav-count: [1-9]\d*/, { timeout: 500 });
      }).toPass();
      const count = await counter.textContent();
      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await expect(page.getByTestId("about-marker")).toHaveText("ABOUT_STATIC_MARKER");
      // The layout stays mounted through waku's client navigation, so the
      // client component's state survives the page swap.
      await expect(counter).toHaveText(count!);
    });
  });
}

// SSG output only exists in the production build: `dist/public` contains the
// prerendered HTML and RSC payload, served by the assets layer in live mode.
test.describe("live ssg", () => {
  const it = Playwright.make("live");

  it("serves the SSG page from assets", async ({ server }) => {
    const response = await server.fetch("/about");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ABOUT_STATIC_MARKER");
  });

  it("serves the SSG RSC payload from assets under the user-configured rscBase", async ({
    server,
  }) => {
    // waku.config.ts sets `rscBase: "custom-rsc"` (default: "RSC") — the
    // payload only lives here when the user's config file is honored.
    const response = await server.fetch("/custom-rsc/R/about.txt");
    expect(response.status).toBe(200);
    const missing = await server.fetch("/RSC/R/about.txt");
    expect(missing.status).toBe(404);
  });

  it("prerendered the cloudflare:workers page inside workerd with real bindings", async () => {
    // The strongest SSG-in-workerd proof: the emitted static HTML for the
    // page with a TOP-LEVEL `cloudflare:workers` import contains the binding
    // value — the prerender ran inside workerd with the worker's env (in
    // Node it would have failed with ERR_UNSUPPORTED_ESM_URL_SCHEME).
    const html = await NodeFs.readFile(
      NodePath.join(import.meta.dirname, "..", "dist", "public", "ssg-env", "index.html"),
      "utf8",
    );
    expect(html).toContain("SSG_ENV_MARKER");
    // React separates adjacent text nodes with `<!-- -->` in SSR output, so
    // match with the comment stripped: `MESSAGE=<!-- -->hello-from-binding`.
    expect(html.replaceAll("<!-- -->", "")).toContain("MESSAGE=hello-from-binding");
  });
});
