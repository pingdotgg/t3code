import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CLIENT_MARKER_FILE = fileURLToPath(
  new URL("../src/client-marker.ts", import.meta.url),
);
const SERVER_MARKER_FILE = fileURLToPath(
  new URL("../src/server-marker.ts", import.meta.url),
);

// Write `content` and poll `check` until the dev server reflects it,
// re-writing periodically: linux CI's watcher occasionally drops the change
// event for a file edited twice in quick succession, and a re-write (same
// bytes, new mtime) re-fires it. Each write is a legitimate hot update, so
// specs asserting update semantics (state preservation) remain valid.
const writeUntil = async (
  file: string,
  content: string,
  check: () => Promise<boolean>,
) => {
  for (let attempt = 0; attempt < 12; attempt++) {
    await writeFile(file, content, "utf8");
    for (let poll = 0; poll < 10; poll++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`edit to ${file} never propagated to the dev server`);
};

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    // ---- mode-shared smoke: the fixture pulls its weight in live mode too.

    it("loads the page and hydrates the counter", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#client-marker")).toHaveText(
        "client-marker-v1",
      );
      await expect(page.locator("#counter")).toHaveText("Count is 0");
      await page.click("#counter");
      await expect(page.locator("#counter")).toHaveText("Count is 1");
    });

    it("serves the worker API route", async ({ server }) => {
      const body = await server.fetchJson<{ marker: string }>("/api/marker");
      expect(body.marker).toBe("server-marker-v1");
    });

    it("serves static assets from public/", async ({ server }) => {
      const response = await server.fetch("/hello.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello-from-public");
    });

    // ---- dev-only: edit propagation under the Cloudflare vite plugin.

    it("applies a client-module edit as a hot update that preserves state", async ({
      page,
      server,
    }) => {
      test.skip(mode === "live", "HMR is a dev-server behavior");

      await page.goto(server.url.toString());
      await expect(page.locator("#client-marker")).toHaveText(
        "client-marker-v1",
      );

      // Establish client state that only survives a HOT update: a full page
      // reload re-runs client.ts and resets the counter to 0.
      await page.click("#counter");
      await expect(page.locator("#counter")).toHaveText("Count is 1");

      const marker = page.locator("#client-marker");
      const showsMarker = (value: string) => async () =>
        (await marker.textContent()) === value;
      const source = await readFile(CLIENT_MARKER_FILE, "utf8");
      const edited = source.replace('"client-marker-v1"', '"client-marker-v2"');
      expect(edited).not.toBe(source);
      try {
        await writeUntil(
          CLIENT_MARKER_FILE,
          edited,
          showsMarker("client-marker-v2"),
        );
        // The proof of real HMR: the accept callback swapped the marker while
        // the module (and its counter state) stayed alive.
        await expect(page.locator("#counter")).toHaveText("Count is 1");
      } finally {
        // Restore (and wait for it) so later specs see a settled server.
        await writeUntil(
          CLIENT_MARKER_FILE,
          source,
          showsMarker("client-marker-v1"),
        );
      }
      await expect(page.locator("#counter")).toHaveText("Count is 1");
    });

    it("reflects a worker-module edit on a subsequent request", async ({
      server,
    }) => {
      test.skip(mode === "live", "edit propagation is a dev-server behavior");

      // Bounded poll: mid-update requests may fail while the module graph
      // invalidates; treat request errors as "not yet".
      const servesMarker = (value: string) => async () => {
        try {
          const body = await server.fetchJson<{ marker: string }>(
            "/api/marker",
          );
          return body.marker === value;
        } catch {
          // mid-update — the module graph may be invalidating
          return false;
        }
      };
      const expectMarker = async (value: string) => {
        for (let attempt = 0; attempt < 60; attempt++) {
          if (await servesMarker(value)()) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error(
          `timed out waiting for /api/marker to serve "${value}"`,
        );
      };

      await expectMarker("server-marker-v1");
      const source = await readFile(SERVER_MARKER_FILE, "utf8");
      const edited = source.replace('"server-marker-v1"', '"server-marker-v2"');
      expect(edited).not.toBe(source);
      try {
        await writeUntil(
          SERVER_MARKER_FILE,
          edited,
          servesMarker("server-marker-v2"),
        );
      } finally {
        // Restore (and wait for it) so later specs see a settled server.
        await writeUntil(
          SERVER_MARKER_FILE,
          source,
          servesMarker("server-marker-v1"),
        );
      }
    });
  });
}
