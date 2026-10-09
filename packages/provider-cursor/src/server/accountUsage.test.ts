// @effect-diagnostics nodeBuiltinImport:off - the reader under test reads a
// real CLI credential file from disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { CursorKeychainTimeoutError } from "./CursorKeychain.ts";
import { readCursorAccountUsage } from "./accountUsage.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("Cursor account history", () => {
  it("reads Cursor account history with the default macOS Keychain login", async () => {
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    let keychainReads = 0;
    const result = await readCursorAccountUsage(
      { kind: "keychain" },
      0,
      1781000000000,
      async (_url, init) => {
        assert.include(new Headers(init.headers).get("cookie") ?? "", "demo%3A%3A");
        return Response.json({ totalUsageEventsCount: 0, usageEventsDisplay: [] });
      },
      async () => {
        keychainReads++;
        return accessToken;
      },
    );
    assert.strictEqual(keychainReads, 1);
    assert.isNull(result.error);
    assert.isFalse(result.missing);
    assert.isNotNull(result.accountKey);
  });

  it("reads paginated Cursor account history including headless calls with separate cache tokens", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    const pages: number[] = [];
    const signals: AbortSignal[] = [];
    const request = async (url: string, init: RequestInit) => {
      assert.strictEqual(String(url), "https://cursor.com/api/dashboard/get-filtered-usage-events");
      assert.strictEqual(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.strictEqual(headers.get("origin"), "https://cursor.com");
      assert.include(headers.get("cookie") ?? "", "WorkosCursorSessionToken=demo%3A%3A");
      const body = JSON.parse(String(init?.body));
      pages.push(body.page);
      if (init.signal) signals.push(init.signal);
      return Response.json({
        totalUsageEventsCount: 1001,
        usageEventsDisplay: Array.from({ length: body.page === 1 ? 1000 : 1 }, (_, index) => ({
          timestamp: String(1780000000000 + ((body.page - 1) * 1000 + index) * 1000),
          model: "claude-sonnet-4-5",
          conversationId: `conversation-${body.page}`,
          isHeadless: body.page === 2,
          chargedCents: 0,
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 30,
            cacheWriteTokens: 2,
            totalCents: 25,
          },
        })),
      });
    };
    const result = await readCursorAccountUsage(authPath, 0, 1781000000000, request);
    assert.isNull(result.error);
    assert.deepStrictEqual(pages, [1, 2]);
    assert.lengthOf(signals, 2);
    assert.notStrictEqual(signals[0], signals[1]);
    assert.strictEqual(result.records.length, 1001);
    assert.strictEqual(result.records.at(-1)?.sessionId, "conversation-2");
    assert.deepStrictEqual(result.records[0]?.totals, {
      uncachedInputTokens: 10,
      cachedInputTokens: 30,
      cacheCreationTokens: 2,
      outputTokens: 5,
      reasoningTokens: 0,
    });
    assert.strictEqual(result.records[0]?.reportedCostUsd, 0.25);
    assert.isFalse(result.accountKey?.includes("demo") ?? true);
  });

  it("reads Cursor account history beyond 100 pages", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    const fullPage = Array.from({ length: 1000 }, () => ({ tokenUsage: null }));
    let requests = 0;
    const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () => {
      requests += 1;
      return Response.json({
        totalUsageEventsCount: 100_001,
        usageEventsDisplay: requests <= 100 ? fullPage : [{ tokenUsage: null }],
      });
    });
    assert.isNull(result.error);
    assert.strictEqual(requests, 101);
    assert.deepStrictEqual(result.records, []);
  });

  it("accepts confirmed empty Cursor usage but rejects error envelopes", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    for (const body of [
      {},
      { totalUsageEventsCount: 0 },
      { totalUsageEventsCount: 0, usageEventsDisplay: [] },
    ]) {
      const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () =>
        Response.json(body),
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(result.records, []);
      assert.isFalse(result.missing);
    }
    for (const body of [
      { error: "upstream error" },
      { detail: "unknown error envelope" },
      { totalUsageEventsCount: 0, error: "upstream error" },
      null,
      [],
      "invalid",
      0,
    ]) {
      const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () =>
        Response.json(body),
      );
      assert.isNotNull(result.error);
      assert.deepStrictEqual(result.records, []);
    }
  });

  it("requires a terminal Cursor page after a full page reaches the reported count", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    let requests = 0;
    const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () => {
      requests++;
      return Response.json(
        requests === 1
          ? {
              totalUsageEventsCount: 1000,
              usageEventsDisplay: Array.from({ length: 1000 }, (_, index) => ({
                timestamp: String(1780000000000 + index),
                model: "gpt-5",
                tokenUsage: { inputTokens: 10, outputTokens: 5 },
              })),
            }
          : { totalUsageEventsCount: 1000 },
      );
    });
    assert.isNull(result.error);
    assert.strictEqual(result.records.length, 1000);
    assert.strictEqual(requests, 2);
  });

  it("removes only count-proven Cursor boundary copies and preserves identical billed events", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    const event = (index: number) => ({
      timestamp: String(1780000000000 + index),
      model: "gpt-5",
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
    });
    for (const total of [2000, 2001]) {
      let requests = 0;
      const result = await readCursorAccountUsage(authPath, 0, 1781000000000, async () => {
        requests++;
        return Response.json({
          totalUsageEventsCount: total,
          usageEventsDisplay:
            requests === 1
              ? Array.from({ length: 1000 }, (_, index) => event(index))
              : requests === 2
                ? Array.from({ length: 1000 }, (_, index) => event(999 + index))
                : [event(1999)],
        });
      });
      assert.isNull(result.error);
      assert.strictEqual(result.records.length, total);
      assert.strictEqual(requests, 3);
      assert.strictEqual(result.records.at(-1)?.timestampMs, 1780000001999);
      assert.strictEqual(
        result.records.filter((record) => record.timestampMs === 1780000000999).length,
        total === 2000 ? 1 : 2,
      );
      assert.strictEqual(new Set(result.records.map((record) => record.dedupeKey)).size, total);
    }
    let requests = 0;
    const inconsistent = await readCursorAccountUsage(authPath, 0, 1781000000000, async () => {
      requests++;
      return Response.json({
        totalUsageEventsCount: 1001,
        usageEventsDisplay:
          requests === 1
            ? Array.from({ length: 1000 }, (_, index) => event(index))
            : [event(500), event(1000)],
      });
    });
    assert.isNotNull(inconsistent.error);
    assert.deepStrictEqual(inconsistent.records, []);
  });

  it("does not present truncated Cursor account pages or authentication failures as complete history", async () => {
    const authPath = NodePath.join(dir, "auth.json");
    const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
    await NodeFSP.writeFile(authPath, JSON.stringify({ accessToken }));
    const truncated = await readCursorAccountUsage(authPath, 0, 1781000000000, async () =>
      Response.json({ totalUsageEventsCount: 101, usageEventsDisplay: [] }),
    );
    assert.isNotNull(truncated.error);
    assert.deepStrictEqual(truncated.records, []);
    const denied = await readCursorAccountUsage(
      authPath,
      0,
      1781000000000,
      async () => new Response(accessToken, { status: 401 }),
    );
    assert.isNotNull(denied.error);
    assert.isFalse(denied.error?.includes(accessToken) ?? true);
    assert.deepStrictEqual(denied.records, []);
    let requested = false;
    const missing = await readCursorAccountUsage(
      NodePath.join(dir, "missing.json"),
      0,
      1781000000000,
      async () => {
        requested = true;
        return Response.json({});
      },
    );
    assert.isTrue(missing.missing);
    assert.isFalse(requested);
  });
});

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
