import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { makeModelproxyApi, mapModelproxyStatus, ModelproxyStatus } from "./modelproxyApi.ts";

const now = Date.parse("2026-09-23T12:00:00Z");
const iso = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(now + offsetMs));

/** The wire payload as modelproxy sends it, including fields Lathe ignores. */
const raw = {
  current: "james-max",
  threshold: 0.9,
  fableThreshold: 0.85,
  apiCapUsd: 0,
  spendWindow: "day",
  totalSpendUsd: 0,
  openaiCapUsd: 0,
  openaiSpendUsd: 0,
  openrouterCapUsd: -1,
  openrouterSpendUsd: 3.4,
  openrouterWindow: "day",
  inflightTotal: 2,
  queueDepth: 0,
  maxPerAccount: 0,
  maxTotal: 0,
  rolling: {
    windowSeconds: 300,
    count: 10,
    c429: 0,
    c502: 0,
    c503: 0,
    c529: 0,
    p50Ms: 1,
    p95Ms: 2,
    p99Ms: 3,
  },
  forecast: {
    workloadRatePerHour: 0.14,
    fableRatePerHour: 0.09,
    spendRateUsdPerHour: 0.8,
    apiSpendRateUsdPerHour: 0,
    fleet: { kind: "at", at: iso(4 * 3_600_000) },
    fable: { kind: "resetsFirst", at: iso(96 * 3_600_000) },
    api: { kind: "disabled" },
  },
  accounts: [
    {
      name: "james-max",
      type: "oauth",
      provider: "anthropic",
      current: true,
      disabled: false,
      priority: 1,
      util5h: 0.62,
      has5h: true,
      reset5h: iso(2 * 3_600_000),
      util7d: 0.41,
      has7d: true,
      reset7d: iso(100 * 3_600_000),
      perModel: { fable: 0.58 },
      perModelReset: { fable: iso(100 * 3_600_000) },
      spendUsd: 0,
      inflight: 2,
      pinnedSessions: 1,
    },
    {
      name: "zeus-pro",
      type: "oauth",
      provider: "anthropic",
      current: false,
      disabled: false,
      priority: 2,
      util5h: 0.96,
      has5h: true,
      reset5h: iso(1.7 * 3_600_000),
      util7d: 0.58,
      has7d: true,
      reset7d: iso(90 * 3_600_000),
      spendUsd: 0,
      inflight: 0,
      pinnedSessions: 0,
      coolingUntil: iso(20_000),
    },
    {
      name: "codex-james",
      type: "oauth",
      provider: "openai",
      current: false,
      disabled: false,
      priority: 1,
      util5h: 0.35,
      has5h: true,
      reset5h: iso(3 * 3_600_000),
      util7d: 0.71,
      has7d: true,
      reset7d: iso(76 * 3_600_000),
      credits: true,
      spendUsd: 0,
      inflight: 0,
      pinnedSessions: 0,
    },
    {
      name: "stale",
      type: "oauth",
      provider: "anthropic",
      current: false,
      disabled: false,
      priority: 9,
      util5h: 0,
      has5h: false,
      util7d: 0,
      has7d: false,
      spendUsd: 0,
      inflight: 0,
      pinnedSessions: 0,
      health: { state: "reauthentication_required", recovery: "modelproxy login stale" },
    },
    {
      name: "openrouter-main",
      type: "apikey",
      provider: "openrouter",
      current: false,
      disabled: false,
      priority: 5,
      util5h: 0,
      has5h: false,
      util7d: 0,
      has7d: false,
      spendUsd: 3.4,
      capUsd: -1,
      spendWindow: "day",
      inflight: 0,
      pinnedSessions: 0,
    },
  ],
  routes: [
    {
      kind: "model",
      from: "kimi-k3",
      to: "moonshotai/kimi-k3",
      provider: "openrouter",
      price: { inUsd: 3, cachedInUsd: 0.3, outUsd: 15 },
    },
    { kind: "model", from: "claude-opus-4-8", to: "claude-opus-5", provider: "anthropic" },
    {
      kind: "fallback",
      from: "claude-fable-5",
      to: "anthropic/claude-fable-5",
      provider: "openrouter",
      price: { inUsd: 15, cachedInUsd: 1.5, outUsd: 75 },
    },
  ],
  events: [],
  generatedAt: iso(0),
};
const decodeStatus = Schema.decodeUnknownSync(ModelproxyStatus);
const decodeTypedStatus = Schema.decodeSync(ModelproxyStatus);
const status = decodeStatus(raw);

describe("mapModelproxyStatus", () => {
  const mapped = mapModelproxyStatus(status, { checkedAt: iso(0), nowMs: now });

  it("keeps subscription accounts with their windows as percentages", () => {
    expect(mapped.accounts.map((account) => account.id)).toEqual([
      "james-max",
      "zeus-pro",
      "codex-james",
      "stale",
    ]);
    const james = mapped.accounts[0]!;
    expect(String(james.driver)).toBe("claudeAgent");
    expect(james.usageLimits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 62],
      ["seven_day", 41],
      ["seven_day_fable", 58],
    ]);
    expect(james.usageLimits.windows[0]?.resetsAt).toBe(iso(2 * 3_600_000));
    expect(String(mapped.accounts[2]!.driver)).toBe("codex");
  });

  it("derives the gateway's own account state", () => {
    expect(mapped.accounts.map((account) => account.proxy?.state)).toEqual([
      "live",
      "cooling",
      "ready",
      "reauthentication",
    ]);
    expect(mapped.accounts[1]!.proxy?.coolingUntil).toBe(iso(20_000));
    expect(mapped.accounts[2]!.proxy?.credits).toBe(true);
    expect(mapped.accounts[0]!.proxy?.inflight).toBe(2);
  });

  it("reports a window never observed as unavailable rather than 0%", () => {
    const stale = mapped.accounts[3]!;
    expect(stale.usageLimits.windows).toEqual([]);
    expect(stale.usageLimits.unavailable?.reason).toBe("probeFailed");
  });

  it("summarises the gateway for the header widget", () => {
    expect(mapped.proxy.current).toBe("james-max");
    expect(mapped.proxy.rotationThresholdPercent).toBe(90);
    expect(mapped.proxy.modelThresholdPercent).toBe(85);
    expect(mapped.proxy.runway).toEqual({ kind: "at", at: iso(4 * 3_600_000) });
    expect(mapped.proxy.inflightTotal).toBe(2);
    expect(mapped.proxy.fallback).toEqual([
      { name: "openrouter-main", provider: "openrouter", spendUsd: 3.4, window: "day" },
    ]);
  });

  it("publishes model routes and drops fallbacks, whose names the picker already has", () => {
    expect(mapped.proxy.routes).toEqual([
      { kind: "model", from: "kimi-k3", to: "moonshotai/kimi-k3", provider: "openrouter" },
      { kind: "model", from: "claude-opus-4-8", to: "claude-opus-5", provider: "anthropic" },
    ]);
  });

  it("treats a route without a kind as a model route and skips one it cannot read", () => {
    const decoded = decodeStatus({
      ...raw,
      routes: [{ from: "gpt-6", to: "gpt-6", provider: "openai" }, { from: "broken" }],
    });
    expect(mapModelproxyStatus(decoded, { checkedAt: iso(0), nowMs: now }).proxy.routes).toEqual([
      { from: "gpt-6", to: "gpt-6", provider: "openai" },
    ]);
  });

  it("reads a gateway that predates route publishing", () => {
    const { routes: _routes, ...older } = raw;
    const decoded = decodeStatus(older);
    expect(mapModelproxyStatus(decoded, { checkedAt: iso(0), nowMs: now }).proxy.routes).toBe(
      undefined,
    );
  });
});

describe("mapModelproxyStatus reset credits", () => {
  const base = {
    current: "",
    threshold: 0.9,
    inflightTotal: 0,
    queueDepth: 0,
    forecast: { fleet: { kind: "idle" as const } },
  };
  const subscription = (name: string, provider: string, extra: Record<string, unknown>) => ({
    name,
    type: "oauth",
    provider,
    current: false,
    disabled: false,
    util5h: 0.1,
    has5h: true,
    util7d: 0.2,
    has7d: true,
    spendUsd: 0,
    inflight: 0,
    ...extra,
  });

  it("maps weekly, usable-now and Fable counts, keyed by kind", () => {
    const status = decodeTypedStatus({
      ...base,
      accounts: [
        subscription("claude-1", "anthropic", {
          resetCredits: {
            weekly: 1,
            usableNow: 1,
            fable: 2,
            nextWeekly: { id: "full-reset-2611", expiresAt: "2026-12-10T22:00:00Z" },
            nextFable: { id: "launch-2610-fable", expiresAt: "2027-03-09T07:59:00Z" },
          },
        }),
        subscription("codex-james", "openai", { resetCredits: { weekly: 3, usableNow: 0 } }),
        subscription("old", "anthropic", {}),
      ],
    });
    const { accounts } = mapModelproxyStatus(status, { checkedAt: iso(0), nowMs: now });
    const byId = new Map(accounts.map((account) => [account.id, account]));

    expect(byId.get("claude-1")?.usageLimits.resetCredits).toEqual({
      availableCount: 1,
      usableNowCount: 1,
      nextCreditId: "weekly",
      nextExpiresAt: "2026-12-10T22:00:00.000Z",
      fable: {
        availableCount: 2,
        nextCreditId: "fable",
        nextExpiresAt: "2027-03-09T07:59:00.000Z",
      },
    });
    expect(byId.get("codex-james")?.usageLimits.resetCredits).toEqual({
      availableCount: 3,
      usableNowCount: 0,
      nextCreditId: "weekly",
    });
    expect(byId.get("old")?.usageLimits.resetCredits).toBeUndefined();
  });

  it("drops reset credits it cannot read without losing the status", () => {
    const status = decodeTypedStatus({
      ...base,
      accounts: [
        subscription("drifted", "anthropic", { resetCredits: { weekly: "one" } }),
        subscription("nulled", "anthropic", { resetCredits: null }),
      ],
    });
    const { accounts } = mapModelproxyStatus(status, { checkedAt: iso(0), nowMs: now });
    expect(accounts.map((account) => account.id)).toEqual(["drifted", "nulled"]);
    for (const account of accounts) {
      expect(account.usageLimits.resetCredits).toBeUndefined();
      expect(account.usageLimits.windows.length).toBeGreaterThan(0);
    }
  });
});

describe("makeModelproxyApi", () => {
  it.effect("reads the status endpoint with the bearer token", () =>
    Effect.gen(function* () {
      let authorization: string | undefined;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          authorization = request.headers.authorization;
          expect(new URL(request.url).pathname).toBe("/api/status");
          return HttpClientResponse.fromWeb(request, Response.json(raw));
        }),
      );
      const api = yield* makeModelproxyApi.pipe(Effect.provideService(HttpClient.HttpClient, http));
      const result = yield* api.readStatus("https://iris.test", "access-token");
      expect(authorization).toBe("Bearer access-token");
      expect(result.current).toBe("james-max");
      expect(result.accounts).toHaveLength(5);
    }),
  );

  it.effect("names an expired or rejected token so the caller can re-authenticate", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(request, new Response("RBAC: access denied", { status: 403 })),
        ),
      );
      const api = yield* makeModelproxyApi.pipe(Effect.provideService(HttpClient.HttpClient, http));
      const result = yield* api.readStatus("https://iris.test", "stale").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.unauthorized).toBe(true);
        expect(result.failure.detail).toContain("403");
      }
    }),
  );
});

/** A server-sent-events body delivered in the given chunks. */
function eventStream(chunks: ReadonlyArray<string>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("makeModelproxyApi.streamStatus", () => {
  const streamWith = (
    response: () => Response,
    seen?: (request: HttpClientRequest.HttpClientRequest) => void,
  ) =>
    makeModelproxyApi.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            seen?.(request);
            return HttpClientResponse.fromWeb(request, response());
          }),
        ),
      ),
    );

  it.effect("follows each status event, however the body is chunked", () =>
    Effect.gen(function* () {
      let authorization: string | undefined;
      let path: string | undefined;
      const second = JSON.stringify({ ...raw, current: "james-pro" });
      const first = `event: status\ndata: ${JSON.stringify(raw)}\n\n`;
      const api = yield* streamWith(
        () =>
          eventStream([
            first.slice(0, 40),
            first.slice(40),
            ": keepalive\n\n",
            `event: status\ndata: ${second.slice(0, 10)}`,
            `${second.slice(10)}\n\n`,
          ]),
        (request) => {
          path = new URL(request.url).pathname;
          authorization = request.headers.authorization;
        },
      );
      const statuses = yield* api
        .streamStatus("https://iris.test", "access-token")
        .pipe(Stream.runCollect);
      expect(path).toBe("/api/status/stream");
      expect(authorization).toBe("Bearer access-token");
      expect(statuses.map((status) => status.current)).toEqual(["james-max", "james-pro"]);
    }),
  );

  it.effect("skips an event this build cannot read and keeps following", () =>
    Effect.gen(function* () {
      const api = yield* streamWith(() =>
        eventStream([
          "event: status\ndata: {not json\n\n",
          'event: status\ndata: {"current":1}\n\n',
          `event: status\ndata: ${JSON.stringify(raw)}\n\n`,
        ]),
      );
      const statuses = yield* api
        .streamStatus("https://iris.test", "access-token")
        .pipe(Stream.runCollect);
      expect(statuses.map((status) => status.current)).toEqual(["james-max"]);
    }),
  );

  it.effect("tells a gateway without the stream from a rejected session", () =>
    Effect.gen(function* () {
      const failureFor = (status: number) =>
        streamWith(() => new Response("no", { status })).pipe(
          Effect.flatMap((api) =>
            api.streamStatus("https://iris.test", "token").pipe(Stream.runDrain, Effect.flip),
          ),
        );
      const missing = yield* failureFor(404);
      expect(missing.unsupported).toBe(true);
      expect(missing.unauthorized).toBeUndefined();
      const rejected = yield* failureFor(401);
      expect(rejected.unauthorized).toBe(true);
      const down = yield* failureFor(503);
      expect(down.transient).toBe(true);
      const page = yield* streamWith(
        () => new Response("<html>sign in</html>", { headers: { "Content-Type": "text/html" } }),
      ).pipe(
        Effect.flatMap((api) =>
          api.streamStatus("https://iris.test", "token").pipe(Stream.runDrain, Effect.flip),
        ),
      );
      expect(page.unsupported).toBe(true);
    }),
  );
});

describe("makeModelproxyApi.redeemResetCredit", () => {
  const redeemWith = (
    respond: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
  ) =>
    makeModelproxyApi.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          respond(request).pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          ),
        ),
      ),
    );
  const input = { account: "claude-1", kind: "weekly" as const, requestId: "req-1" };
  /** A 200 whose body never finishes arriving. */
  const stalledBody = () => new Response(new ReadableStream({ start: () => {} }), { status: 200 });

  it.effect("waits for a redeem that takes a minute", () =>
    Effect.gen(function* () {
      const api = yield* redeemWith(() =>
        Effect.as(Effect.sleep("60 seconds"), Response.json({ outcome: "reset" })),
      );
      const fiber = yield* api
        .redeemResetCredit("https://iris.test", "token", input)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("61 seconds");
      expect(yield* Fiber.join(fiber)).toBe("reset");
    }),
  );

  it.effect(
    "bounds the request and its body by one timeout, and says the reset may have applied",
    () =>
      Effect.gen(function* () {
        const api = yield* redeemWith(() => Effect.as(Effect.sleep("60 seconds"), stalledBody()));
        const fiber = yield* api
          .redeemResetCredit("https://iris.test", "token", input)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("89 seconds");
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        const failure = yield* Fiber.join(fiber);
        expect(failure.transient).toBe(true);
        expect(failure.detail).toContain("may have applied");
        expect(failure.detail).toContain("will not spend a second credit");
      }),
  );

  it.effect("says the reset may have applied when the connection fails", () =>
    Effect.gen(function* () {
      const api = yield* redeemWith((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "reset by peer" }),
          }),
        ),
      );
      const failure = yield* api
        .redeemResetCredit("https://iris.test", "token", input)
        .pipe(Effect.flip);
      expect(failure.transient).toBe(true);
      expect(failure.detail).toContain("may have applied");
      expect(failure.detail).toContain("will not spend a second credit");
    }),
  );

  it.effect("carries the HTTP status of a refusal", () =>
    Effect.gen(function* () {
      const api = yield* redeemWith(() =>
        Effect.succeed(new Response(JSON.stringify({ error: "bad kind" }), { status: 400 })),
      );
      const failure = yield* api
        .redeemResetCredit("https://iris.test", "token", input)
        .pipe(Effect.flip);
      expect(failure.status).toBe(400);
      expect(failure.detail).toContain("bad kind");
    }),
  );
});
