import { assert, describe, it } from "@effect/vitest";

import { CursorKeychainTimeoutError } from "@t3tools/provider-cursor/server";
import { readCursorAccountUsage } from "./cursorUsageReader.ts";

describe("readCursorAccountUsage", () => {
  it("asks for Keychain approval when the prompt goes unanswered", async () => {
    const result = await readCursorAccountUsage(
      { kind: "keychain" },
      0,
      1,
      () => Promise.reject(new Error("no network expected")),
      () => Promise.reject(new CursorKeychainTimeoutError()),
    );
    assert.deepStrictEqual(result, {
      accountKey: null,
      records: [],
      missing: false,
      error: "Allow Keychain access on the Mac running T3 Code, then refresh.",
    });
  });

  it("reads the pages behind the first together and keeps them in page order", async () => {
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    let inFlight = 0;
    let mostInFlight = 0;
    const result = await readCursorAccountUsage(
      { kind: "keychain" },
      0,
      1781000000000,
      async (_url, init) => {
        const page: number = JSON.parse(String(init.body)).page;
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        // Later pages answer first, so record order cannot come from arrival order.
        for (let turn = page; turn < 9; turn++) await Promise.resolve();
        inFlight--;
        return Response.json({
          totalUsageEventsCount: 8001,
          usageEventsDisplay: Array.from({ length: page === 9 ? 1 : 1000 }, (_, index) => ({
            timestamp: String(1780000000000 + (page - 1) * 1000 + index),
            model: "gpt-5",
            tokenUsage: { inputTokens: 1 },
          })),
        });
      },
      async () => accessToken,
    );
    assert.isNull(result.error);
    assert.strictEqual(mostInFlight, 6);
    assert.deepStrictEqual(
      result.records.map((record) => record.timestampMs),
      Array.from({ length: 8001 }, (_, index) => 1780000000000 + index),
    );
  });

  it("ends like a page-by-page read when a page fails, leaving no request open", async () => {
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    const fullPage = {
      totalUsageEventsCount: 8001,
      usageEventsDisplay: Array.from({ length: 1000 }, () => ({ tokenUsage: null })),
    };
    // Page 3 fails while the pages after it are still waiting on Cursor.
    for (const [secondPage, error] of [
      [() => Response.json(fullPage), "Cursor account usage could not be read."],
      [() => new Response(null, { status: 401 }), "Sign in to Cursor again to read account usage."],
    ] as const) {
      let open = 0;
      const result = await readCursorAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        (_url, init) => {
          const page: number = JSON.parse(String(init.body)).page;
          if (page === 1) return Promise.resolve(Response.json(fullPage));
          if (page === 2) return Promise.resolve(secondPage());
          if (page === 3) return Promise.reject(new Error("connection reset"));
          open++;
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              open--;
              reject(init.signal?.reason);
            });
          });
        },
        async () => accessToken,
      );
      assert.strictEqual(result.error, error);
      assert.deepStrictEqual(result.records, []);
      assert.strictEqual(open, 0);
    }
  });
});
