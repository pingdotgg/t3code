import * as Playwright from "@alchemy.run/cloudflare-test-tools/e2e/Playwright";
import { expect, test } from "@playwright/test";

const get = (server: { url: URL }, path: string) => fetch(new URL(path, server.url));

const stampOf = (body: string, prefix: string): string | undefined =>
  body.match(new RegExp(`${prefix}:(?:<!-- -->)?(\\d+)`))?.[1];

/** GET `path` until `predicate(stamp)` holds — bounded polling. */
const pollStamp = async (
  server: { url: URL },
  path: string,
  prefix: string,
  predicate: (stamp: string) => boolean,
  { times = 40, delayMs = 500 }: { times?: number; delayMs?: number } = {},
): Promise<string> => {
  let last: string | undefined;
  for (let i = 0; i < times; i++) {
    const response = await get(server, path);
    if (response.status === 200) {
      last = stampOf(await response.text(), prefix);
      if (last !== undefined && predicate(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`stamp never satisfied predicate (last: ${last})`);
};

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("caches the ISR page in KV across requests", async ({ server }) => {
      const first = await get(server, "/isr");
      expect(first.status).toBe(200);
      const stamp = stampOf(await first.text(), "isr-stamp");
      expect(stamp).toBeDefined();

      // Within the (long) revalidate window the KV-cached payload serves
      // as-is — same stamp on every hit.
      const second = await get(server, "/isr");
      expect(stampOf(await second.text(), "isr-stamp")).toBe(stamp);
    });

    it("revalidatePath purges the writable cache (on-demand ISR)", async ({ server }) => {
      // Prime the cache and capture the current stamp.
      const primed = await pollStamp(server, "/isr", "isr-stamp", () => true);

      const revalidate = await fetch(new URL("/api/revalidate", server.url), {
        method: "POST",
      });
      expect(revalidate.status).toBe(200);
      expect((await revalidate.json()) as object).toEqual({ revalidated: true });

      // The purge lands in KV; the next render produces a NEW stamp. With
      // the read-only static-assets cache this would never change — this
      // assertion is the proof the cache is writable.
      const fresh = await pollStamp(server, "/isr", "isr-stamp", (s) => s !== primed);
      expect(fresh).not.toBe(primed);
    });

    it("time-based revalidation regenerates through the DO queue", async ({ server }) => {
      test.setTimeout(90_000);
      // Prime the 2s-revalidate page.
      const primed = await pollStamp(server, "/fast-isr", "fast-isr-stamp", () => true);

      // Let the window lapse, then keep hitting: the first stale hit
      // enqueues a background revalidation (DO queue → self-reference
      // fetch → KV write); a later hit serves the regenerated payload.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const fresh = await pollStamp(server, "/fast-isr", "fast-isr-stamp", (s) => s !== primed, {
        times: 60,
      });
      expect(fresh).not.toBe(primed);
    });
  });
}
