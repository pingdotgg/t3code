import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as CursorKeychain from "./CursorKeychain.ts";
import { readCursorAccountUsage } from "./accountUsage.ts";

const writeAuth = (accessToken: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
    const authPath = path.join(dir, "auth.json");
    yield* fileSystem.writeFileString(authPath, JSON.stringify({ accessToken }));
    return { dir, authPath };
  });

interface DashboardRequest {
  readonly method: string;
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
}

const dashboard = (answer: (request: DashboardRequest) => Response | Promise<Response>) =>
  HttpClient.make((request, url, signal, fiber) =>
    Effect.tryPromise({
      try: async () => {
        const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const response = await answer({
          method: request.method,
          url: url.toString(),
          init: { ...init, signal, body },
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

const billingItem = (eventTime: string, usage: Record<string, string>) => ({
  billingItemId: `item-${eventTime}`,
  eventTime,
  product: "cursor",
  chargeCategory: "usage",
  usageType: "included",
  principal: { type: "user", id: "user_demo" },
  usage,
  pricing: { currency: "USD", contracted: "0.0000000000" },
  displayExtras: { model: "composer-2.5", userEmail: "user@example.com", displayLabel: "Composer" },
  hasTokenMeters: true,
  totalTokens: "0",
});

const billingItemsRequest = (request: DashboardRequest) => {
  const url = new URL(request.url);
  return request.method === "GET" &&
    url.origin === "https://cursor.com" &&
    url.pathname === "/api/dashboard/v2/query-billing-items"
    ? url.searchParams
    : null;
};

const JAN_1 = Date.parse("2026-01-01T00:00:00Z");
const JAN_2 = Date.parse("2026-01-02T00:00:00Z");

const demoToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;

describe("Cursor account history", () => {
  it.effect("sends the Cursor session only to cursor.com, one request per billing page", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      const requests: DashboardRequest[] = [];
      const result = yield* readAccountUsage(
        authPath,
        Date.parse("2026-10-31T00:00:00Z"),
        Date.parse("2026-11-01T00:00:00Z"),
        async (request) => {
          requests.push(request);
          return Response.json({
            data: [],
            pagination: { nextCursor: requests.length === 1 ? "page-2" : null },
          });
        },
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(
        requests.map(({ url }) => Object.fromEntries(new URL(url).searchParams)),
        [
          {
            scope: "user",
            startTime: "2026-10-31T00:00:00.000Z",
            endTime: "2026-11-01T00:00:00.000Z",
            pageSize: "1000",
          },
          {
            scope: "user",
            startTime: "2026-10-31T00:00:00.000Z",
            endTime: "2026-11-01T00:00:00.000Z",
            pageSize: "1000",
            cursor: "page-2",
          },
        ],
      );
      for (const { method, url, init, headers } of requests) {
        assert.strictEqual(method, "GET");
        assert.isNotNull(billingItemsRequest({ method, url, init, headers }));
        assert.strictEqual(init.redirect, "error");
        assert.strictEqual(headers.get("origin"), "https://cursor.com");
        assert.include(headers.get("cookie") ?? "", "WorkosCursorSessionToken=demo%3A%3A");
      }
      assert.notStrictEqual(requests[0]?.init.signal, requests[1]?.init.signal);
      assert.isFalse(result.accountKey?.includes("demo") ?? true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prices included billing items from the rate table and keeps contracted charges", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      const item = (eventTime: string, pricing: { currency: string; contracted: string }) => ({
        ...billingItem(eventTime, { "prompt-text-tokens": "10" }),
        pricing,
      });
      const result = yield* readAccountUsage(authPath, JAN_1, JAN_2, async () =>
        Response.json({
          data: [
            item("2026-01-01T00:00:00.000Z", { currency: "USD", contracted: "0.0000000000" }),
            item("2026-01-01T00:00:01.000Z", { currency: "USD", contracted: "0.0125000000" }),
            item("2026-01-01T00:00:02.000Z", { currency: "EUR", contracted: "1.0000000000" }),
          ],
        }),
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(
        result.records.map((record) => record.reportedCostUsd),
        [null, 0.0125, null],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps identically billed items apart and counts a repeated item once", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      const usage = { "completion-text-tokens": "5" };
      const first = { ...billingItem("2026-01-01T00:00:00.000Z", usage), billingItemId: "a" };
      const twin = { ...first, billingItemId: "b" };
      const result = yield* readAccountUsage(authPath, JAN_1, JAN_2, async ({ url }) =>
        Response.json(
          new URL(url).searchParams.get("cursor") === null
            ? { data: [first, twin], pagination: { nextCursor: "page-2" } }
            : { data: [twin] },
        ),
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(
        result.records.map((record) => record.dedupeKey),
        [`cursor-account:${result.accountKey}:a`, `cursor-account:${result.accountKey}:b`],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts confirmed empty Cursor usage but rejects error envelopes", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      for (const body of [
        { data: [] },
        { data: [], pagination: {} },
        { data: [], pagination: { nextCursor: null } },
        {
          data: [
            { billingItemId: "fee", chargeCategory: "subscription", hasTokenMeters: false },
            { billingItemId: "seat", chargeCategory: "subscription" },
          ],
        },
      ]) {
        const result = yield* readAccountUsage(authPath, JAN_1, JAN_2, async () =>
          Response.json(body),
        );
        assert.isNull(result.error, JSON.stringify(body));
        assert.deepStrictEqual(result.records, []);
        assert.isFalse(result.missing);
      }
      for (const body of [
        {},
        { error: "upstream error" },
        { data: [], error: "upstream error" },
        { message: "Unauthorized" },
        { data: {} },
        { data: [], pagination: "next" },
        { data: [], pagination: { nextCursor: 2 } },
        { data: [], pagination: { nextCursor: "" } },
        null,
        [],
        "invalid",
        0,
      ]) {
        const result = yield* readAccountUsage(authPath, JAN_1, JAN_2, async () =>
          Response.json(body),
        );
        assert.isNotNull(result.error, JSON.stringify(body));
        assert.deepStrictEqual(result.records, []);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects billing items it cannot account for", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      const valid = billingItem("2026-01-01T00:00:00.000Z", { "prompt-text-tokens": "10" });
      for (const item of [
        null,
        { ...valid, eventTime: "yesterday" },
        { ...valid, eventTime: undefined },
        { ...valid, displayExtras: {} },
        { ...valid, billingItemId: undefined },
        { ...valid, usage: "10" },
        { ...valid, usage: { "prompt-text-tokens": "-1" } },
        { ...valid, usage: { "prompt-text-tokens": "1.5" } },
        { ...valid, usage: { "completion-text-tokens": "many" } },
        { ...valid, usage: { "cached-prompt-text-tokens": -1 } },
      ]) {
        const result = yield* readAccountUsage(authPath, JAN_1, JAN_2, async () =>
          Response.json({ data: [valid, item] }),
        );
        assert.isNotNull(result.error, JSON.stringify(item));
        assert.deepStrictEqual(result.records, []);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops when Cursor repeats a pagination cursor", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      let requests = 0;
      const result = yield* readAccountUsage(authPath, JAN_1, JAN_2, async () => {
        requests++;
        return Response.json({ data: [], pagination: { nextCursor: "same" } });
      });
      assert.isNotNull(result.error);
      assert.strictEqual(requests, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads day slices six at a time and counts an item on a slice boundary once", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      const day = (date: number, hour = 0) =>
        `2026-11-0${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;
      const eventTimes = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((date) =>
        date === 8 ? [day(date)] : [day(date), day(date, 12)],
      );
      const firstPages: string[] = [];
      let open = 0;
      let mostOpen = 0;
      const { promise: sixOpen, resolve: release } = Promise.withResolvers<void>();
      const result = yield* readAccountUsage(
        authPath,
        Date.parse(day(1)),
        Date.parse(day(8)),
        async ({ url }) => {
          const params = new URL(url).searchParams;
          const start = Date.parse(params.get("startTime") ?? "");
          const end = Date.parse(params.get("endTime") ?? "");
          // Each slice ends where the next begins, so Cursor returns midnight items twice.
          const inSlice = eventTimes.filter((time) => {
            const ms = Date.parse(time);
            return ms >= start && ms <= end;
          });
          if (params.get("cursor") === "page-2")
            return Response.json({
              data: inSlice
                .slice(1)
                .map((time) => billingItem(time, { "prompt-text-tokens": "1" })),
            });
          firstPages.push(`${params.get("startTime")}/${params.get("endTime")}`);
          mostOpen = Math.max(mostOpen, ++open);
          if (open === 6) release();
          await sixOpen;
          open--;
          return Response.json({
            data: inSlice
              .slice(0, 1)
              .map((time) => billingItem(time, { "prompt-text-tokens": "1" })),
            pagination: { nextCursor: "page-2" },
          });
        },
      );
      assert.isNull(result.error);
      assert.strictEqual(mostOpen, 6);
      assert.deepStrictEqual(
        firstPages.toSorted(),
        [1, 2, 3, 4, 5, 6, 7].map((date) => `${day(date)}/${day(date + 1)}`),
      );
      assert.deepStrictEqual(
        result.records.map((record) => record.timestampMs),
        eventTimes.map((time) => Date.parse(time)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("asks for 100 items a page when Cursor rejects 1,000", () =>
    Effect.gen(function* () {
      const { authPath } = yield* writeAuth(demoToken);
      const pageSizes: (string | null)[] = [];
      const result = yield* readAccountUsage(authPath, JAN_1, JAN_2, async ({ url }) => {
        const params = new URL(url).searchParams;
        pageSizes.push(params.get("pageSize"));
        if (params.get("pageSize") === "1000") return new Response(null, { status: 400 });
        return params.get("cursor") === null
          ? Response.json({
              data: [billingItem("2026-01-01T00:00:00.000Z", { "prompt-text-tokens": "1" })],
              pagination: { nextCursor: "page-2" },
            })
          : Response.json({
              data: [billingItem("2026-01-01T00:00:01.000Z", { "prompt-text-tokens": "1" })],
            });
      });
      assert.isNull(result.error);
      assert.strictEqual(result.records.length, 2);
      assert.deepStrictEqual(pageSizes, ["1000", "100", "100"]);

      pageSizes.length = 0;
      const rejected = yield* readAccountUsage(authPath, JAN_1, JAN_2, async ({ url }) => {
        pageSizes.push(new URL(url).searchParams.get("pageSize"));
        return new Response(null, { status: 400 });
      });
      assert.strictEqual(rejected.error, "Cursor account usage could not be read.");
      assert.deepStrictEqual(pageSizes, ["1000", "100"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not present authentication failures or missing credentials as history", () =>
    Effect.gen(function* () {
      const { dir, authPath } = yield* writeAuth(demoToken);
      const denied = yield* readAccountUsage(
        authPath,
        0,
        1781000000000,
        async () => new Response(demoToken, { status: 401 }),
      );
      assert.strictEqual(denied.error, "Sign in to Cursor again to read account usage.");
      assert.deepStrictEqual(denied.records, []);
      let requested = false;
      const missing = yield* readAccountUsage(
        (yield* Path.Path).join(dir, "missing.json"),
        0,
        1781000000000,
        async () => {
          requested = true;
          return Response.json({ data: [] });
        },
      );
      assert.isTrue(missing.missing);
      assert.isFalse(requested);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Cursor account billing items", () => {
  it.effect("reads Cursor account history from the dashboard's billing items", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      const result = yield* readAccountUsage(
        authPath,
        Date.parse("2026-11-01T00:00:00Z"),
        Date.parse("2026-11-02T00:00:00Z"),
        async (request) => {
          const params = billingItemsRequest(request);
          // Cursor still answers the old usage-events endpoint, with an empty body.
          if (params === null) return Response.json({});
          assert.strictEqual(params.get("scope"), "user");
          assert.include(
            request.headers.get("cookie") ?? "",
            "WorkosCursorSessionToken=demo%3A%3A",
          );
          return params.get("cursor") === "page-2"
            ? Response.json({
                data: [billingItem("2026-11-01T01:00:00.000Z", { "completion-text-tokens": "7" })],
              })
            : Response.json({
                data: [
                  billingItem("2026-11-01T03:43:46.022Z", {
                    "cache-write-text-tokens": "0",
                    "cached-prompt-text-tokens": "46400",
                    "completion-text-tokens": "312",
                    "prompt-text-tokens": "1263",
                  }),
                ],
                pagination: { nextCursor: "page-2" },
              });
        },
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(
        result.records.map((record) => ({
          timestampMs: record.timestampMs,
          model: record.model,
          totals: record.totals,
        })),
        [
          {
            timestampMs: Date.parse("2026-11-01T03:43:46.022Z"),
            model: "composer-2.5",
            totals: {
              uncachedInputTokens: 1263,
              cachedInputTokens: 46400,
              cacheCreationTokens: 0,
              outputTokens: 312,
              reasoningTokens: 0,
            },
          },
          {
            timestampMs: Date.parse("2026-11-01T01:00:00.000Z"),
            model: "composer-2.5",
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 7,
              reasoningTokens: 0,
            },
          },
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not present a billing response without items as empty history", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () =>
        Response.json({}),
      );
      assert.isNotNull(result.error, "a response without billing items read as empty history");
      assert.deepStrictEqual(result.records, []);
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

  it.effect("ends on a failed or stalled page, leaving no request open", () =>
    Effect.gen(function* () {
      const firstPage = {
        data: [billingItem("2026-01-01T00:00:00.000Z", { "prompt-text-tokens": "10" })],
        pagination: { nextCursor: "page-2" },
      };
      for (const [secondPage, error] of [
        [
          () => Promise.resolve(new Response(null, { status: 401 })),
          "Sign in to Cursor again to read account usage.",
        ],
        [
          () => Promise.reject(new Error("connection reset")),
          "Cursor account usage could not be read.",
        ],
        [undefined, "Cursor account usage could not be read."],
      ] as const) {
        let open = 0;
        const { promise: stalled, resolve: stall } = Promise.withResolvers<void>();
        const read = yield* readAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          ({ url, init }) => {
            if (new URL(url).searchParams.get("cursor") === null)
              return Promise.resolve(Response.json(firstPage));
            if (secondPage !== undefined) return secondPage();
            open++;
            stall();
            return new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                open--;
                reject(init.signal?.reason);
              });
            });
          },
          Effect.succeed(demoToken),
        ).pipe(Effect.forkChild);
        if (secondPage === undefined) {
          yield* Effect.promise(() => stalled);
          yield* TestClock.adjust("10 seconds");
        }
        const result = yield* Fiber.join(read);
        assert.strictEqual(result.error, error);
        assert.deepStrictEqual(result.records, []);
        assert.strictEqual(open, 0);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
