import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    accounts?: Array<
      (typeof accounts)[number] & {
        disabled?: boolean;
        id_token: { chatgpt_account_id: string; plan_type?: string; chatgpt_plan_type?: string };
      }
    >;
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: options.accounts ?? accounts }),
        );
      if (path.endsWith("/reset-quota"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({}, { status: options.cooldownStatus ?? 200 }),
        );
      expect(path).toMatch(/\/v0\/management\/api-call$/);
      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    }),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(NodeCrypto.layer),
    ),
  };
}

const unreachableHub = (
  fail: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => HttpClientError.HttpClientError,
) =>
  makeCliproxyApi.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.fail(fail(request))),
    ),
    Effect.provide(NodeCrypto.layer),
  );

describe("CLIProxyAPI hub failures", () => {
  it.effect("names the TLS code when the hub's certificate is not trusted", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              // Node's fetch wraps the TLS error, which carries the code, in a generic TypeError.
              cause: new TypeError("fetch failed", {
                cause: Object.assign(new Error("unable to get local issuer certificate"), {
                  code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                }),
              }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
      expect(error.detail).toContain("NODE_EXTRA_CA_CERTS");
    }),
  );

  // regression: #18168 Limits hub failures name their TLS, HTTP, or timeout cause
  it.effect("ignores a transport code that is not a short Node error code", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("odd"), { code: "X".repeat(200) }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toBe("The hub management request failed.");
    }),
  );

  it.effect("names the status, not the body, when the hub rejects the request", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "management-secret is wrong" }, { status: 401 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, test),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("401");
      expect(error.detail).not.toContain("management-secret");
    }),
  );
});

function metaFixture() {
  const state = {
    token: "dca:first-secret",
    authIndex: "meta-index",
    status: 200,
    downloadStatus: 200,
    usage: {
      subs_usage: { window: { used_percent: 12 }, weekly: { used_percent: 63 } },
    } as unknown,
    mintCalls: 0,
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: [{ id: "meta.json", auth_index: state.authIndex, provider: "meta" }],
          }),
        );
      if (url.pathname.endsWith("/auth-files/download"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ dca_token: state.token }, { status: state.downloadStatus }),
        );
      const body = decodeRequest(
        new TextDecoder().decode(
          request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(),
        ),
      );
      expect(body.header?.Authorization).toBe(`Bearer ${state.token}`);
      expect(body.url).toBe("https://api.meta.ai/muse-code/key");
      state.mintCalls += 1;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: state.status, body: encodeJson(state.usage) }),
      );
    }),
  );
  return {
    state,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(NodeCrypto.layer),
    ),
  };
}

describe("Muse quota refresh", () => {
  it.effect("retains the original observation and marks failed refreshes until recovery", () =>
    Effect.gen(function* () {
      const test = metaFixture();
      const api = yield* test.api;
      const first = (yield* api.readAccounts(config))[0]!;
      test.state.status = 503;
      test.state.usage = { error: "private-key" };
      yield* TestClock.adjust("60 seconds");
      const failed = (yield* api.readAccounts(config))[0]!;
      expect(failed.usageLimits.windows).toEqual(first.usageLimits.windows);
      expect(failed.usageLimits.checkedAt).toBe(first.usageLimits.checkedAt);
      expect(failed.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(encodeJson(failed)).not.toContain("private-key");
      yield* api.readAccounts(config);
      expect(test.state.mintCalls).toBe(2);
      yield* TestClock.adjust("60 seconds");
      const failedAgain = (yield* api.readAccounts(config))[0]!;
      expect(failedAgain.usageLimits.checkedAt).toBe(first.usageLimits.checkedAt);
      expect(failedAgain.usageLimits.windows).toEqual(first.usageLimits.windows);
      test.state.status = 200;
      test.state.usage = { subs_usage: { window: { used_percent: 33 } } };
      yield* TestClock.adjust("60 seconds");
      const recovered = (yield* api.readAccounts(config))[0]!;
      expect(recovered.usageLimits.unavailable).toBeUndefined();
      expect(recovered.usageLimits.windows[0]?.usedPercent).toBe(33);
      expect(recovered.usageLimits.checkedAt).not.toBe(first.usageLimits.checkedAt);
    }),
  );

  it.effect.each([
    { name: "missing usage", usage: {} },
    { name: "null usage", usage: { subs_usage: null } },
    { name: "malformed usage", usage: { subs_usage: { window: { used_percent: "secret" } } } },
  ])("retains successful windows after $name", ({ usage }) =>
    Effect.gen(function* () {
      const test = metaFixture();
      const api = yield* test.api;
      const first = (yield* api.readAccounts(config))[0]!;
      test.state.usage = usage;
      yield* TestClock.adjust("60 seconds");
      const result = (yield* api.readAccounts(config))[0]!;
      expect(result.usageLimits.windows).toEqual(first.usageLimits.windows);
      expect(result.usageLimits.checkedAt).toBe(first.usageLimits.checkedAt);
      expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect(
    "reports malformed first observations and invalid credentials without leaking secrets",
    () =>
      Effect.gen(function* () {
        const test = metaFixture();
        test.state.usage = { subs_usage: { weekly: { used_percent: "secret-usage" } } };
        const api = yield* test.api;
        const result = (yield* api.readAccounts(config))[0]!;
        expect(result.usageLimits.windows).toEqual([]);
        expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
        expect(encodeJson(result)).not.toContain("secret-usage");
        test.state.token = "invalid-secret";
        const invalid = (yield* api.readAccounts(config))[0]!;
        expect(invalid.usageLimits.windows).toEqual([]);
        expect(invalid.usageLimits.unavailable?.reason).toBe("probeFailed");
        expect(encodeJson(invalid)).not.toContain("invalid-secret");
        expect(test.state.mintCalls).toBe(1);
      }),
  );

  it.effect("evicts old credential entries to bound retained quota memory", () =>
    Effect.gen(function* () {
      const test = metaFixture();
      const api = yield* test.api;
      yield* api.readAccounts(config);
      for (let index = 0; index < 128; index += 1) {
        test.state.token = `dca:credential-${index}`;
        yield* api.readAccounts(config);
      }
      test.state.token = "dca:first-secret";
      test.state.status = 503;
      const result = (yield* api.readAccounts(config))[0]!;
      expect(result.usageLimits.windows).toEqual([]);
      expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(test.state.mintCalls).toBe(130);
    }),
  );

  it.effect("does not reuse quota after DCA, auth-index, management-key or hub rotation", () =>
    Effect.gen(function* () {
      const test = metaFixture();
      const api = yield* test.api;
      const first = (yield* api.readAccounts(config))[0]!;
      expect(first.usageLimits.windows).toHaveLength(2);
      test.state.status = 503;
      const rotated = { ...config, managementKey: "rotated-management" };
      const moved = { ...config, url: "http://other-hub.test" };
      for (const nextConfig of [rotated, moved]) {
        const result = (yield* api.readAccounts(nextConfig))[0]!;
        expect(result.usageLimits.windows).toEqual([]);
        expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
      }
      test.state.token = "dca:rotated-secret";
      const result = (yield* api.readAccounts(config))[0]!;
      expect(result.usageLimits.windows).toEqual([]);
      expect(result.usageLimits.credentialFingerprint).not.toBe(
        first.usageLimits.credentialFingerprint,
      );
      expect(encodeJson(result)).not.toContain("rotated-secret");
      test.state.authIndex = "rotated-index";
      yield* api.readAccounts(config);
      expect(test.state.mintCalls).toBe(5);
    }),
  );

  it.effect("does not retain unverifiable credentials when auth download fails", () =>
    Effect.gen(function* () {
      const test = metaFixture();
      const api = yield* test.api;
      yield* api.readAccounts(config);
      test.state.downloadStatus = 503;
      const result = (yield* api.readAccounts(config))[0]!;
      expect(result.usageLimits.windows).toEqual([]);
      expect(result.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(test.state.mintCalls).toBe(1);
    }),
  );

  it.effect("serializes concurrent refreshes for the same credential", () =>
    Effect.gen(function* () {
      const test = metaFixture();
      const api = yield* test.api;
      const results = yield* Effect.all([api.readAccounts(config), api.readAccounts(config)], {
        concurrency: 2,
      });
      expect(results[0]).toEqual(results[1]);
      expect(test.state.mintCalls).toBe(1);
    }),
  );
});

describe("CLIProxyAPI built-in management API", () => {
  it.effect("reads Muse quota without exposing credentials", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          calls.push(url.pathname);
          if (url.pathname.endsWith("/auth-files"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ files: [{ id: "meta.json", auth_index: "m", provider: "meta" }] }),
            );
          if (url.pathname.endsWith("/auth-files/download"))
            return HttpClientResponse.fromWeb(request, Response.json({ dca_token: "dca:fixture" }));
          const body = decodeRequest(
            new TextDecoder().decode(
              request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(),
            ),
          );
          expect(body.header?.Authorization).toBe("Bearer dca:fixture");
          expect(body.url).toBe("https://api.meta.ai/muse-code/key");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              status_code: 200,
              body: JSON.stringify({
                api_key: "secret-key",
                subs_tier_name: "Muse Max",
                subs_usage: {
                  window: { used_percent: 10, window_duration_mins: 300, resets_at: 1793200020 },
                  weekly: { used_percent: 62, resets_at: 1793577600 },
                },
              }),
            }),
          );
        }),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeCrypto.layer),
      );
      const result = yield* api.readAccounts(config);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        driver: "muse",
        plan: "Muse Max",
        usageLimits: {
          windows: [
            {
              id: "window",
              kind: "session",
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1793200020000)),
            },
            {
              id: "weekly",
              kind: "weekly",
              usedPercent: 62,
              resetsAt: DateTime.formatIso(DateTime.makeUnsafe(1793577600000)),
            },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toContain("fixture");
      expect(JSON.stringify(result)).not.toContain("secret-key");
      expect(calls).toContain("/v0/management/auth-files/download");
      yield* api.readAccounts(config);
      expect(calls.filter((path) => path.endsWith("/api-call"))).toHaveLength(1);
      yield* TestClock.adjust("61 seconds");
      yield* api.readAccounts(config);
      expect(calls.filter((path) => path.endsWith("/api-call"))).toHaveLength(2);
    }),
  );
  it.effect("reports unavailable Muse windows without inventing a quota", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/auth-files"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                files: [
                  { id: "meta.json", auth_index: "m", provider: "meta" },
                  { id: "disabled.json", auth_index: "d", provider: "meta", disabled: true },
                ],
              }),
            );
          if (path.endsWith("/auth-files/download"))
            return HttpClientResponse.fromWeb(request, Response.json({ dca_token: "dca:fixture" }));
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              status_code: 200,
              body: encodeJson({ api_key: "secret", subs_usage: null }),
            }),
          );
        }),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeCrypto.layer),
      );
      const result = yield* api.readAccounts(config);
      expect(result).toHaveLength(1);
      expect(result[0]?.usageLimits.windows).toEqual([]);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(JSON.stringify(result)).not.toContain("secret");
    }),
  );
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture();
        const api = yield* test.api;
        const result = yield* api.readAccounts(config);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
      }),
  );

  it.effect("resolves a missing usage plan from current, then legacy, token plans", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          { ...accounts[0]!, id_token: { chatgpt_account_id: "account-a", plan_type: "free" } },
          {
            ...accounts[1]!,
            id_token: {
              chatgpt_account_id: "account-b",
              plan_type: "go",
              chatgpt_plan_type: "plus",
            },
          },
          {
            ...accounts[1]!,
            id: "third.json",
            auth_index: "c",
            id_token: { chatgpt_account_id: "account-c", chatgpt_plan_type: "free" },
          },
        ],
        upstream: (request) => ({
          status: 200,
          body: {
            ...(request.auth_index === "a" ? { plan_type: "plus" } : {}),
            rate_limit: { primary_window: { used_percent: 12 } },
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result.map((account) => [account.plan, account.usageLimits.windows[0]?.kind])).toEqual(
        [
          ["ChatGPT Plus Subscription", "session"],
          ["ChatGPT Go Subscription", "monthly"],
          ["ChatGPT Free Subscription", "monthly"],
        ],
      );
    }),
  );

  it.effect("keeps the path of a hub served under a prefix", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url: "https://tools.test/cliproxy" });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) => request.path.startsWith("/cliproxy/v0/management/")),
      ).toBe(true);
    }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("maps Claude scoped windows without a scheduler plugin", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        // The usage endpoint answers 429 to requests without a Claude Code user agent.
        upstream: (request) => ({
          status: request.header?.["User-Agent"]?.startsWith("claude-code/") ? 200 : 429,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  it.effect("pins redemption to the displayed credit and clears only that account's cooldown", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: "519d5243-011a-5b7b-91f3-44d85f095705",
          credit_id: "credit-b",
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/reset-quota"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["b", "b"]);
    }),
  );

  it.effect("reports redemption success even if cooldown clearing fails", () =>
    Effect.gen(function* () {
      const api = yield* fixture({ cooldownStatus: 404 }).api;
      const result = yield* api.consume(config, "first.json", "credit");
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("cooldown");
    }),
  );

  it.effect("skips disabled accounts and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      expect(yield* api.readAccounts(config)).toEqual([]);
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        1,
      );
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );
});
