import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SECRET = "s3cret-from-binding";

// Both modes run the shared contract: `event.context.cloudflare` is served
// natively by the cloudflare_module preset in live mode, and by the
// platform-proxy dev bridge (nitro's SSR worker thread → workerd, wrangler-
// free) in dev mode.
for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("server-renders the home page with the cloudflare env binding", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("page-marker")).toHaveText("NUXT_FIXTURE");
      // `runtimeConfig.public.fixtureMarker` comes from the user's own
      // nuxt.config.ts — proves the config file loaded natively (in dev
      // too: the dev driver injects only the overrides layer).
      await expect(page.getByTestId("config-marker")).toHaveText("user-nuxt-config-loaded");
      // Read during SSR from event.context.cloudflare.env.
      await expect(page.getByTestId("env-secret")).toHaveText(`secret:${SECRET}`);
    });

    it("hydrates the client-interactive counter", async ({ page, server }) => {
      await page.goto(new URL("/counter", server.url).toString());
      await expect(page.locator("#count")).toHaveText("count:0");
      // wait for hydration before interacting (onMounted flips the marker)
      await expect(page.locator("#increment")).toHaveAttribute("data-hydrated", "true");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:1");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:2");
    });

    it("serves the prerendered page", async ({ server }) => {
      // Live: written into .output/public at build time and served by the
      // assets layer. Dev: rendered on demand (dev does not prerender).
      const response = await server.fetch("/prerendered");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("this-page-is-prerendered");
    });

    it("serves static assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent: *");
    });

    it("runs the API route with the cloudflare runtime context", async ({ server }) => {
      const body = await server.fetchJson<{
        marker: string;
        secret: string | null;
        hasWaitUntil: boolean;
      }>("/api/hello");
      expect(body.marker).toBe("api-route-ok");
      expect(body.secret).toBe(SECRET);
      expect(body.hasWaitUntil).toBe(true);
    });

    it("round-trips KV through event.context.cloudflare.env", async ({ server }) => {
      // Random payload data (not a resource name) — fine per the naming
      // doctrine, and proves the read observes THIS run's write.
      const value = `value-${Math.random().toString(36).slice(2)}`;
      const put = await fetch(
        new URL(`/api/kv?key=e2e-key&value=${encodeURIComponent(value)}`, server.url),
        { method: "POST" },
      );
      expect(put.status).toBe(200);
      expect(((await put.json()) as { put: boolean }).put).toBe(true);
      const read = await server.fetchJson<{ value: string | null }>("/api/kv?key=e2e-key");
      expect(read.value).toBe(value);
    });

    if (mode === "live") {
      // Live-only: the Counter DO class reaches the worker through nitro's
      // entry/exports seam (`worker-entry.ts`), which only exists in the
      // production build — the dev platform proxy cannot host it (yet).
      it("increments the Counter DO exported through the entry/exports seam", async ({
        server,
      }) => {
        // Plain HTTP fetch (not `server.fetch`): the live-mode dispatchFetch
        // wrapper drops RequestInit, losing the POST method.
        const post = async (): Promise<number> => {
          const response = await fetch(new URL("/api/counter", server.url), { method: "POST" });
          expect(response.status).toBe(200);
          const body = (await response.json()) as { count: number };
          return body.count;
        };

        const first = await post();
        const second = await post();
        // Relative assertion: DO storage may persist across runs locally.
        expect(second).toBe(first + 1);

        // GET observes the state written by the POSTs — same DO instance.
        const read = await fetch(new URL("/api/counter", server.url));
        expect(read.status).toBe(200);
        expect(((await read.json()) as { count: number }).count).toBe(second);
      });
    }

    if (mode === "dev") {
      // Dev-only: a server-route edit is reflected on the next request
      // (nitro dev rebuild + worker-thread replacement; the bridge plugin
      // reconnects on its own with binding state intact).
      it("reflects a server-route edit on the next request", async ({ server }) => {
        const file = fileURLToPath(new URL("../server/api/hmr.ts", import.meta.url));
        const source = await readFile(file, "utf8");
        const edited = source.replace('"hmr-marker-v1"', '"hmr-marker-v2"');
        expect(edited).not.toBe(source);

        // Bounded poll: mid-rebuild requests may fail; retry until the
        // expected marker (or give up well inside the test timeout).
        const pollFor = async (expected: string) => {
          for (let attempt = 0; attempt < 30; attempt++) {
            try {
              const body = await server.fetchJson<{ marker: string }>("/api/hmr");
              if (body.marker === expected) return;
            } catch {
              // mid-rebuild — retry
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          throw new Error(`timed out waiting for /api/hmr to serve "${expected}"`);
        };

        await pollFor("hmr-marker-v1");
        try {
          await writeFile(file, edited);
          await pollFor("hmr-marker-v2");
        } finally {
          await writeFile(file, source);
        }
        // Wait for the restore to land so later specs see a settled server.
        await pollFor("hmr-marker-v1");

        // The bridge survived the reloads: bindings still resolve.
        const hello = await server.fetchJson<{ secret: string | null }>("/api/hello");
        expect(hello.secret).toBe(SECRET);
      });
    }
  });
}
