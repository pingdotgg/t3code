import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

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
    beforeCooldownReset?: Effect.Effect<void>;
    beforeUpstreamResponse?: (request: RequestBody) => Effect.Effect<void>;
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const respond = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
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
      if (body && options.beforeUpstreamResponse) yield* options.beforeUpstreamResponse(body);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    });
  const http = HttpClient.make((request) =>
    Effect.andThen(
      request.url.endsWith("/reset-quota")
        ? (options.beforeCooldownReset ?? Effect.void)
        : Effect.void,
      respond(request),
    ),
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

describe("CLIProxyAPI built-in management API", () => {
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

  it.effect(
    "paces usage probes, retains recent readings through 429s, and expires them during backoff",
    () =>
      Effect.gen(function* () {
        let limited = false;
        let probes = 0;
        const test = fixture({
          accounts: [{ ...accounts[0]!, provider: "claude" }],
          upstream: () => {
            probes++;
            return limited
              ? { status: 429, body: {} }
              : { status: 200, body: { five_hour: { utilization: probes * 10, resets_at: null } } };
          },
        });
        const api = yield* test.api;
        const [initial] = yield* api.readAccounts(config);
        expect(initial?.usageLimits.windows[0]?.usedPercent).toBe(10);
        limited = true;
        for (const minutes of [1, 2, 4, 8]) {
          const previousProbes = probes;
          yield* TestClock.adjust(minutes * 60_000 - 1);
          expect((yield* api.readAccounts(config))[0]?.usageLimits).toEqual(initial?.usageLimits);
          expect(probes).toBe(previousProbes);
          yield* TestClock.adjust(1);
          const [account] = yield* api.readAccounts(config);
          expect(probes).toBe(previousProbes + 1);
          if (minutes < 8) {
            expect(account?.usageLimits).toEqual(initial?.usageLimits);
          } else {
            expect(account?.usageLimits.windows).toEqual([]);
            expect(account?.usageLimits.unavailable).toMatchObject({
              reason: "probeFailed",
              message: expect.stringContaining("rate limiting"),
            });
          }
        }
        limited = false;
        yield* TestClock.adjust(8 * 60_000 - 1);
        expect((yield* api.readAccounts(config))[0]?.usageLimits.unavailable?.message).toContain(
          "rate limiting",
        );
        expect(probes).toBe(5);
        yield* TestClock.adjust(1);
        expect((yield* api.readAccounts(config))[0]?.usageLimits.windows[0]?.usedPercent).toBe(60);
        yield* TestClock.adjust("1 minute");
        expect((yield* api.readAccounts(config))[0]?.usageLimits.windows[0]?.usedPercent).toBe(70);
      }),
  );

  it.effect("isolates cached readings by hub, file, provider, email, and workspace", () =>
    Effect.gen(function* () {
      const original = accounts[0]!;
      const listed = [{ ...original }];
      let probes = 0;
      const test = fixture({
        accounts: listed,
        upstream: (request) => {
          if (request.url?.endsWith("/rate-limit-reset-credits"))
            return { status: 200, body: { credits: [] } };
          const percent = ++probes * 10;
          return {
            status: 200,
            body: {
              five_hour: { utilization: percent, resets_at: null },
              rate_limit: { primary_window: { used_percent: percent } },
            },
          };
        },
      });
      const api = yield* test.api;
      const baseline = yield* api.readAccounts(config);
      const identities = [
        { url: "http://other-hub.test:8317", account: original },
        { url: config.url, account: { ...original, id: "replacement.json" } },
        { url: config.url, account: { ...original, provider: "claude" } },
        { url: config.url, account: { ...original, email: "replacement@example.com" } },
        {
          url: config.url,
          account: { ...original, id_token: { chatgpt_account_id: "other-workspace" } },
        },
      ];
      for (const [index, identity] of identities.entries()) {
        listed[0] = identity.account;
        const [account] = yield* api.readAccounts({ ...config, url: identity.url });
        expect(account).toMatchObject({
          id: identity.account.id,
          email: identity.account.email,
          workspaceId: identity.account.id_token.chatgpt_account_id,
          driver: identity.account.provider === "claude" ? "claudeAgent" : "codex",
        });
        expect(account?.usageLimits.windows[0]?.usedPercent).toBe((index + 2) * 10);
      }
      listed[0] = original;
      expect(yield* api.readAccounts(config)).toEqual(baseline);
      expect(probes).toBe(6);
    }),
  );

  it.effect(
    "shares concurrent reads without blocking other identities or retaining a pre-reset reading",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const spent = yield* Deferred.make<void>();
        let probes = 0;
        const test = fixture({
          accounts: [accounts[0]!],
          upstream: (request) => ({
            status: 200,
            body: request.url?.endsWith("/consume")
              ? { code: "reset" }
              : request.url?.endsWith("/rate-limit-reset-credits")
                ? { credits: [] }
                : { rate_limit: { primary_window: { used_percent: ++probes * 10 } } },
          }),
          beforeUpstreamResponse: (request) =>
            request.url?.endsWith("/wham/usage") && probes === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          beforeCooldownReset: Deferred.succeed(spent, undefined).pipe(Effect.asVoid),
        });
        const api = yield* test.api;
        const first = yield* Effect.forkChild(api.readAccounts(config));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(api.readAccounts(config), {
          startImmediately: true,
        });
        const [other] = yield* api.readAccounts({ ...config, url: "http://other-hub.test:8317" });
        expect(other?.usageLimits.windows[0]?.usedPercent).toBe(20);
        const redeem = yield* Effect.forkChild(api.consume(config, "first.json", "credit"));
        yield* Deferred.await(spent);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(first))[0]?.usageLimits.windows[0]?.usedPercent).toBe(10);
        expect((yield* Fiber.join(second))[0]?.usageLimits.windows[0]?.usedPercent).toBe(10);
        expect((yield* Fiber.join(redeem)).outcome).toBe("reset");
        const [fresh] = yield* api.readAccounts(config);
        expect(fresh?.usageLimits.windows[0]?.usedPercent).toBe(30);
        expect(probes).toBe(3);
      }),
  );

  it.effect(
    "retains pacing after a rejected reset but invalidates only the attempted account after success or uncertain failure",
    () =>
      Effect.gen(function* () {
        let resetStatus = 429;
        let limited = false;
        let percent = 12;
        const test = fixture({
          upstream: (request) =>
            request.url?.endsWith("/consume")
              ? { status: resetStatus, body: { code: "reset" } }
              : limited
                ? { status: 429, body: {} }
                : {
                    status: 200,
                    body: request.url?.endsWith("/rate-limit-reset-credits")
                      ? { credits: [] }
                      : { rate_limit: { primary_window: { used_percent: percent } } },
                  },
        });
        const api = yield* test.api;
        const usageProbes = () =>
          test.requests.filter((request) => request.body?.url?.endsWith("/wham/usage")).length;
        const initial = yield* api.readAccounts(config);
        limited = true;
        yield* TestClock.adjust("1 minute");
        expect(yield* api.readAccounts(config)).toEqual(initial);
        expect(usageProbes()).toBe(4);
        expect((yield* Effect.flip(api.consume(config, "first.json", "credit"))).detail).toContain(
          "rate limiting",
        );
        yield* TestClock.adjust("1 minute");
        expect(yield* api.readAccounts(config)).toEqual(initial);
        expect(usageProbes()).toBe(4);

        resetStatus = 200;
        limited = false;
        percent = 0;
        expect((yield* api.consume(config, "first.json", "credit")).outcome).toBe("reset");
        const afterReset = yield* api.readAccounts(config);
        expect(afterReset.map((account) => account.usageLimits.windows[0]?.usedPercent)).toEqual([
          0, 12,
        ]);
        expect(usageProbes()).toBe(5);

        resetStatus = 503;
        limited = true;
        expect((yield* Effect.result(api.consume(config, "first.json", "next-credit")))._tag).toBe(
          "Failure",
        );
        const afterFailure = yield* api.readAccounts(config);
        expect(afterFailure[0]?.usageLimits.windows).toEqual([]);
        expect(afterFailure[0]?.usageLimits.unavailable?.message).toContain("rate limiting");
        expect(afterFailure[1]).toEqual(initial[1]);
        expect(usageProbes()).toBe(6);
      }),
  );

  it.effect("invalidates an account when reset is interrupted after the credit is spent", () =>
    Effect.gen(function* () {
      const spent = yield* Deferred.make<void>();
      const test = fixture({
        beforeCooldownReset: Deferred.succeed(spent, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const api = yield* test.api;
      yield* api.readAccounts(config);
      const redeem = yield* Effect.forkChild(api.consume(config, "second.json", "credit-b"));
      yield* Deferred.await(spent);
      yield* Fiber.interrupt(redeem);
      yield* api.readAccounts(config);
      expect(
        test.requests
          .filter((request) => request.body?.url?.endsWith("/wham/usage"))
          .map((request) => request.body?.auth_index)
          .sort(),
      ).toEqual(["a", "b", "b"]);
    }),
  );

  it.effect.each([
    {
      name: "spend budget",
      budget: {
        spend: {
          enabled: true,
          used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
          limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        },
      },
    },
    {
      name: "extra usage",
      budget: {
        extra_usage: {
          is_enabled: true,
          used_credits: 4_631,
          monthly_limit: 50_000,
          utilization: 9,
        },
      },
    },
  ])("keeps Claude monthly spend from $name beside rolling windows", ({ budget }) =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: { five_hour: { utilization: 10, resets_at: null }, ...budget },
        }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["monthly_spend", expect.closeTo(9.262, 10)],
      ]);
    }),
  );

  it.effect("omits disabled Claude budgets without losing rolling windows", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            spend: { enabled: false, used: null, limit: null },
            extra_usage: {
              is_enabled: false,
              used_credits: null,
              monthly_limit: null,
              utilization: null,
            },
          },
        }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(result[0]?.usageLimits.windows.map((window) => window.id)).toEqual(["five_hour"]);
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
