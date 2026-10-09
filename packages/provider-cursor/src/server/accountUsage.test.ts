import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";

import * as CursorKeychain from "./CursorKeychain.ts";
import { readCursorAccountUsage } from "./accountUsage.ts";

/** A scoped temporary directory holding `auth.json` with `accessToken`. */
const writeAuth = (accessToken: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
    const authPath = path.join(dir, "auth.json");
    yield* fileSystem.writeFileString(authPath, JSON.stringify({ accessToken }));
    return { dir, authPath };
  });

/** One dashboard request as Cursor sees it: the URL, the fetch options and the decoded page. */
interface DashboardRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly page: number;
  readonly headers: Headers;
}

/** Stands in for Cursor's dashboard: `answer` replies to each page request. */
const dashboard = (answer: (request: DashboardRequest) => Response | Promise<Response>) =>
  HttpClient.make((request, url, signal, fiber) =>
    Effect.tryPromise({
      try: async () => {
        const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const response = await answer({
          url: url.toString(),
          init: { ...init, signal, body },
          page: JSON.parse(body).page,
          headers: new Headers(request.headers),
        });
        return HttpClientResponse.fromWeb(request, response);
      },
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }),
  );

/** Runs `readCursorAccountUsage` against `answer` standing in for Cursor. */
const readAccountUsage = (
  credentialSource: Parameters<typeof readCursorAccountUsage>[0],
  sinceMs: number,
  endDate: number,
  answer: (request: DashboardRequest) => Response | Promise<Response>,
  keychainToken?: Parameters<typeof readCursorAccountUsage>[3],
) =>
  readCursorAccountUsage(credentialSource, sinceMs, endDate, keychainToken).pipe(
    Effect.provideService(HttpClient.HttpClient, dashboard(answer)),
  );

describe("Cursor account history", () => {
  it.effect("reads Cursor account history with the default macOS Keychain login", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      let keychainReads = 0;
      const result = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        ({ headers }) => {
          assert.include(headers.get("cookie") ?? "", "demo%3A%3A");
          return Response.json({ totalUsageEventsCount: 0, usageEventsDisplay: [] });
        },
        Effect.sync(() => {
          keychainReads++;
          return accessToken;
        }),
      );
      assert.strictEqual(keychainReads, 1);
      assert.isNull(result.error);
      assert.isFalse(result.missing);
      assert.isNotNull(result.accountKey);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads paginated Cursor account history including headless calls with separate cache tokens",
    () =>
      Effect.gen(function* () {
        const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
        const { authPath } = yield* writeAuth(accessToken);
        const pages: number[] = [];
        const signals: AbortSignal[] = [];
        const request = ({ url, init, headers, page }: DashboardRequest) => {
          assert.strictEqual(url, "https://cursor.com/api/dashboard/get-filtered-usage-events");
          assert.strictEqual(init.redirect, "error");
          assert.strictEqual(headers.get("origin"), "https://cursor.com");
          assert.strictEqual(headers.get("content-type"), "application/json");
          assert.include(headers.get("cookie") ?? "", "WorkosCursorSessionToken=demo%3A%3A");
          const body = { page };
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
        const result = yield* readAccountUsage(authPath, 0, 1781000000000, request);
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
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Cursor account history beyond 100 pages", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      const fullPage = Array.from({ length: 1000 }, () => ({ tokenUsage: null }));
      let requests = 0;
      const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
        requests += 1;
        return Response.json({
          totalUsageEventsCount: 100_001,
          usageEventsDisplay: requests <= 100 ? fullPage : [{ tokenUsage: null }],
        });
      });
      assert.isNull(result.error);
      assert.strictEqual(requests, 101);
      assert.deepStrictEqual(result.records, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts confirmed empty Cursor usage but rejects error envelopes", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      for (const body of [
        {},
        { totalUsageEventsCount: 0 },
        { totalUsageEventsCount: 0, usageEventsDisplay: [] },
      ]) {
        const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () =>
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
        const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () =>
          Response.json(body),
        );
        assert.isNotNull(result.error);
        assert.deepStrictEqual(result.records, []);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires a terminal Cursor page after a full page reaches the reported count", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      let requests = 0;
      const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
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
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "removes only count-proven Cursor boundary copies and preserves identical billed events",
    () =>
      Effect.gen(function* () {
        const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
        const { authPath } = yield* writeAuth(accessToken);
        const event = (index: number) => ({
          timestamp: String(1780000000000 + index),
          model: "gpt-5",
          tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
        });
        for (const total of [2000, 2001]) {
          let requests = 0;
          const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
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
        const inconsistent = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
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
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not present truncated Cursor account pages or authentication failures as complete history",
    () =>
      Effect.gen(function* () {
        const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
        const { dir, authPath } = yield* writeAuth(accessToken);
        const truncated = yield* readAccountUsage(authPath, 0, 1781000000000, async () =>
          Response.json({ totalUsageEventsCount: 101, usageEventsDisplay: [] }),
        );
        assert.isNotNull(truncated.error);
        assert.deepStrictEqual(truncated.records, []);
        const denied = yield* readAccountUsage(
          authPath,
          0,
          1781000000000,
          async () => new Response(accessToken, { status: 401 }),
        );
        assert.isNotNull(denied.error);
        assert.isFalse(denied.error?.includes(accessToken) ?? true);
        assert.deepStrictEqual(denied.records, []);
        let requested = false;
        const missing = yield* readAccountUsage(
          (yield* Path.Path).join(dir, "missing.json"),
          0,
          1781000000000,
          async () => {
            requested = true;
            return Response.json({});
          },
        );
        assert.isTrue(missing.missing);
        assert.isFalse(requested);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("readCursorAccountUsage", () => {
  it.effect("asks for Keychain approval when the prompt goes unanswered", () =>
    Effect.gen(function* () {
      const result = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1,
        () => {
          throw new Error("no network expected");
        },
        Effect.fail(new CursorKeychain.CursorKeychainTimeoutError()),
      );
      assert.deepStrictEqual(result, {
        accountKey: null,
        records: [],
        missing: false,
        error: "Allow Keychain access on the Mac running T3 Code, then refresh.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the pages behind the first together and keeps them in page order", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      let inFlight = 0;
      let mostInFlight = 0;
      const result = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        async ({ page }) => {
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
        Effect.succeed(accessToken),
      );
      assert.isNull(result.error);
      assert.strictEqual(mostInFlight, 6);
      assert.deepStrictEqual(
        result.records.map((record) => record.timestampMs),
        Array.from({ length: 8001 }, (_, index) => 1780000000000 + index),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ends like a page-by-page read when a page fails, leaving no request open", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const fullPage = {
        totalUsageEventsCount: 8001,
        usageEventsDisplay: Array.from({ length: 1000 }, () => ({ tokenUsage: null })),
      };
      // Page 3 fails while the pages after it are still waiting on Cursor.
      for (const [secondPage, error] of [
        [() => Response.json(fullPage), "Cursor account usage could not be read."],
        [
          () => new Response(null, { status: 401 }),
          "Sign in to Cursor again to read account usage.",
        ],
      ] as const) {
        let open = 0;
        const result = yield* readAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          ({ init, page }) => {
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
          Effect.succeed(accessToken),
        );
        assert.strictEqual(result.error, error);
        assert.deepStrictEqual(result.records, []);
        assert.strictEqual(open, 0);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
