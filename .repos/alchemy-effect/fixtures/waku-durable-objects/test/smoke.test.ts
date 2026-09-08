import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

// Specs written against the INTENDED custom-worker-entry behavior (see
// README): the deployed worker is the user's src/worker-entry.ts, which
// wraps waku's fetch handler and exports the Counter SQLite DO.
for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("SSR renders the page through the wrapped waku handler", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("page-marker")).toHaveText("PAGE_MARKER");
      await expect(page.getByTestId("env-message")).toHaveText(
        "MESSAGE=hello-from-waku-do-binding",
      );
      // The page reads the DO at request time: any non-negative count proves
      // the COUNTER namespace resolved against the user entry's Counter class.
      await expect(page.getByTestId("do-count")).toHaveText(/COUNT=\d+/);
    });

    it("increments the Counter DO across requests via the API route", async ({ server }) => {
      // Plain HTTP fetch (not `server.fetch`): the live-mode dispatchFetch
      // wrapper drops RequestInit, losing the POST method. Both modes listen
      // on a real socket.
      const post = async (): Promise<number> => {
        const response = await fetch(new URL("/counter", server.url), { method: "POST" });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { count: number };
        return body.count;
      };

      const first = await post();
      const second = await post();
      // Relative assertion: DO storage may persist across runs locally.
      expect(second).toBe(first + 1);

      // GET observes the state written by the POSTs — same DO instance.
      const read = await fetch(new URL("/counter", server.url));
      expect(read.status).toBe(200);
      expect(((await read.json()) as { count: number }).count).toBe(second);
    });

    it("serves the static asset alongside the custom entry", async ({ server }) => {
      const response = await server.fetch("/hello.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello from public/");
    });
  });
}
