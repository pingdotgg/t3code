import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
    accounts?: Array<{
      id: string;
      auth_index: string;
      provider: string;
      email?: string;
      disabled?: boolean;
      project_id?: string;
      id_token?: { chatgpt_account_id: string; plan_type?: string; chatgpt_plan_type?: string };
    }>;
    upstream?: (request: RequestBody) => {
      status: number;
      body: unknown;
      headers?: Record<string, string[]>;
    };
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
        Response.json({
          status_code: upstream.status,
          body: encodeJson(upstream.body),
          header: "headers" in upstream ? upstream.headers : undefined,
        }),
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

describe("CLIProxyAPI built-in management API", () => {
  it.effect.each([
    { status: 429, retry: 420 },
    { status: 503, retry: 420 },
    { status: 429, retry: 1 },
    { status: 503, retry: 1 },
  ])(
    "paces filtered Claude accounts, caches responses, and shares HTTP %s cooldowns",
    ({ status, retry }) =>
      Effect.gen(function* () {
        const deadline = 300_000 + Math.max(300_000, retry * 1000);
        let limited = false;
        const test = fixture({
          accounts: accounts.map((account) => ({ ...account, provider: "claude" })),
          upstream: () =>
            limited
              ? { status, body: {}, headers: { "Retry-After": [String(retry)] } }
              : { status: 200, body: { five_hour: { utilization: 25, resets_at: null } } },
        });
        const api = yield* test.api;
        expect(yield* api.readAccounts(config, ["codex"])).toEqual([]);
        const first = yield* api.readAccounts(config, ["claudeAgent"]);
        expect(first.map((account) => account.usageLimits.windows[0]?.usedPercent)).toEqual([
          25, 25,
        ]);
        yield* TestClock.adjust("1 minute");
        const cached = yield* api.readAccounts(config, ["claudeAgent"]);
        expect(cached.map((account) => account.usageLimits.checkedAt)).toEqual(
          first.map((account) => account.usageLimits.checkedAt),
        );
        expect(cached.map((account) => account.usageLimits.refreshAfter)).toEqual([
          300_000, 300_000,
        ]);
        expect(
          test.requests.filter((request) => request.body?.url?.endsWith("/api/oauth/usage")),
        ).toHaveLength(2);
        limited = true;
        yield* TestClock.adjust("4 minutes");
        const stale = yield* api.readAccounts(config, ["claudeAgent"]);
        expect(stale.map((account) => account.usageLimits.unavailable?.reason)).toEqual([
          "probeFailed",
          "probeFailed",
        ]);
        expect(stale.map((account) => account.usageLimits.refreshAfter)).toEqual([
          deadline,
          deadline,
        ]);
        yield* TestClock.adjust("4 minutes");
        const cooling = yield* api.readAccounts(config, ["claudeAgent"]);
        expect(cooling.map((account) => account.usageLimits.refreshAfter)).toEqual([
          deadline,
          deadline,
        ]);
        expect(
          test.requests.filter((request) => request.body?.url?.endsWith("/api/oauth/usage")),
        ).toHaveLength(4);
        limited = false;
        yield* TestClock.adjust(deadline - 540_000);
        const recovered = yield* api.readAccounts(config, ["claudeAgent"]);
        expect(recovered.map((account) => account.usageLimits.windows[0]?.usedPercent)).toEqual([
          25, 25,
        ]);
        expect(
          test.requests.filter((request) => request.body?.url?.endsWith("/api/oauth/usage")),
        ).toHaveLength(6);
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

  it.effect.each([
    "https://tools.test/cliproxy",
    "https://tools.test/cliproxy/",
    "https://tools.test/cliproxy/management.html",
    "https://tools.test/cliproxy/management.html/",
    "https://tools.test/cliproxy/MANAGEMENT.HTML",
    "https://tools.test/cliproxy/management.html?tab=accounts",
    "https://tools.test/cliproxy/management.html#accounts",
    "https://tools.test/cliproxy/management.html/?tab=accounts",
    "https://tools.test/cliproxy/management.html/#accounts",
  ])("keeps the path of a hub served under a prefix: %s", (url) =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) => request.path.startsWith("/cliproxy/v0/management/")),
      ).toBe(true);
    }),
  );

  it.effect("preserves a hub path that only ends with the panel filename", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url: "https://tools.test/team-management.html" });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) =>
          request.path.startsWith("/team-management.html/v0/management/"),
        ),
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

  const antigravitySummary = {
    buckets: [
      {
        bucketId: "gemini-weekly",
        window: "weekly",
        remainingFraction: 0.75,
        resetTime: "2099-01-01T00:00:00Z",
      },
    ],
  };

  it.effect("reads an xAI account as Grok with Grok CLI headers", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ id: "xai.json", auth_index: "x", provider: "xai", email: "x@example.com" }],
        upstream: () => ({
          status: 200,
          body: {
            config: {
              creditUsagePercent: 40,
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2099-01-01T00:00:00Z" },
            },
          },
        }),
      });
      const [account] = yield* (yield* test.api).readAccounts(config);
      expect(account).toMatchObject({ driver: "grok", email: "x@example.com" });
      expect(account?.usageLimits.windows).toMatchObject([
        { id: "subscription", kind: "weekly", usedPercent: 40 },
      ]);
      const call = test.requests.find((request) => request.body?.url)?.body;
      expect(call?.method).toBe("GET");
      expect(call?.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      expect(call?.header).toMatchObject({
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": expect.any(String),
        "User-Agent": expect.stringMatching(/^grok-cli\//),
      });
    }),
  );

  it.effect("reads an Antigravity summary and keys the account by its Google ID", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            id: "antigravity-g@example.com.json",
            auth_index: "g",
            provider: "antigravity",
            email: "g@example.com",
            project_id: "project-7",
          },
        ],
        upstream: (request) => ({
          status: 200,
          body: request.url?.endsWith("/userinfo") ? { id: "google-42" } : antigravitySummary,
        }),
      });
      const [account] = yield* (yield* test.api).readAccounts(config);
      expect(account?.driver).toBe("antigravity");
      expect(account?.email).toBeUndefined();
      expect(account?.usageLimits.credentialFingerprint).toBe(
        // sha256("google-account\0google-42"), as a local Antigravity probe reports it.
        "136d4952771fd67a3600053f37492cbd05828712e0b1c89ebab03d4c22ab6554",
      );
      expect(account?.usageLimits.windows).toMatchObject([
        { id: "gemini-weekly", kind: "weekly", usedPercent: 25 },
      ]);
      const summary = test.requests.find((request) => request.body?.method === "POST")?.body;
      expect(summary?.url).toBe(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      );
      expect(summary?.data).toBe(encodeJson({ project: "project-7" }));
      expect(summary).toMatchObject({
        auth_index: "g",
        method: "POST",
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "User-Agent":
            "antigravity/hub/2.24.0 (aidev_client; os_type=linux; arch=x64; cl=963137146)",
        },
      });
      const identityCalls = test.requests.filter((request) =>
        request.body?.url?.endsWith("/userinfo"),
      );
      expect(identityCalls).toHaveLength(1);
      expect(identityCalls[0]?.body).toMatchObject({
        method: "GET",
        url: "https://www.googleapis.com/oauth2/v2/userinfo",
        header: { Authorization: "Bearer $TOKEN$" },
      });
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
    ),
  );

  it.effect("keeps Antigravity limits and listing email when its identity read fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          {
            id: "antigravity.json",
            auth_index: "g",
            provider: "antigravity",
            email: "g@example.com",
            project_id: "project-7",
          },
        ],
        upstream: (request) =>
          request.url?.endsWith("/userinfo")
            ? { status: 403, body: { error: "denied" } }
            : {
                status: 200,
                body: antigravitySummary,
              },
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(result).toHaveLength(1);
      const [account] = result;
      expect(account).toMatchObject({ driver: "antigravity", email: "g@example.com" });
      expect(account?.usageLimits.credentialFingerprint).toBeUndefined();
      expect(account?.usageLimits.unavailable).toBeUndefined();
      expect(account?.usageLimits.windows).toMatchObject([
        { id: "gemini-weekly", kind: "weekly", usedPercent: 25 },
      ]);
    }),
  );

  it.effect.each([
    { name: "a refused xAI call", provider: "xai", status: 403, body: { error: "denied" } },
    { name: "a malformed xAI answer", provider: "xai", status: 200, body: { config: "x" } },
    { name: "a refused Antigravity call", provider: "antigravity", status: 401, body: {} },
    { name: "a malformed Antigravity answer", provider: "antigravity", status: 200, body: [] },
    { name: "an empty Antigravity summary", provider: "antigravity", status: 200, body: {} },
  ])("reports $name as unreadable", ({ provider, status, body }) =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ id: `${provider}.json`, auth_index: "a", provider, project_id: "project-7" }],
        upstream: () => ({ status, body }),
      });
      const [account] = yield* (yield* test.api).readAccounts(config);
      expect(account?.usageLimits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect.each([undefined, "", "  "])(
    "rejects a missing or blank Antigravity project (%s) before upstream calls",
    (project_id) =>
      Effect.gen(function* () {
        const test = fixture({
          accounts: [
            {
              id: "antigravity.json",
              auth_index: "a",
              provider: "antigravity",
              ...(project_id === undefined ? {} : { project_id }),
            },
          ],
        });
        const [account] = yield* (yield* test.api).readAccounts(config);
        expect(account?.usageLimits.unavailable?.reason).toBe("probeFailed");
        expect(test.requests.map((request) => request.path)).toEqual(["/v0/management/auth-files"]);
      }),
  );

  it.effect("skips accounts of providers the hub table does not know", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          { id: "kiro.json", auth_index: "k", provider: "kiro", email: "k@example.com" },
          { ...accounts[0]!, provider: "claude" },
        ],
        upstream: () => ({ status: 200, body: { five_hour: { utilization: 1, resets_at: null } } }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(result.map((account) => account.driver)).toEqual(["claudeAgent"]);
      expect(test.requests.map((request) => request.body?.auth_index)).not.toContain("k");
    }),
  );

  it.effect.each(["reset", "already_redeemed", "no_credit"] as const)(
    "pins redemption and clears the correct routing cooldown after %s",
    (code) =>
      Effect.gen(function* () {
        let consumed = false;
        const test = fixture({
          upstream: (request) => {
            if (request.url?.endsWith("/consume")) {
              consumed = true;
              return { status: 200, body: { code } };
            }
            if (request.auth_index === "a" || consumed) return { status: 503, body: {} };
            if (request.url?.endsWith("/rate-limit-reset-credits"))
              return { status: 200, body: { credits: [credit("credit-b")] } };
            return {
              status: 200,
              body: { plan_type: "pro", rate_limit: { primary_window: { used_percent: 80 } } },
            };
          },
        });
        const api = yield* test.api;
        const initial = yield* api.readAccounts(config);
        expect(initial[1]?.usageLimits.resetCredits?.nextCreditId).toBe("credit-b");
        const outcome =
          code === "reset" ? "reset" : code === "already_redeemed" ? "alreadyRedeemed" : "noCredit";
        expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome });
        expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome });
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
        ).toEqual(code === "no_credit" ? [] : ["b", "b"]);
        yield* api.readAccounts(config);
        expect(
          test.requests.filter(
            (request) => request.body?.auth_index === "a" && request.body.url?.endsWith("/usage"),
          ),
        ).toHaveLength(1);
        yield* TestClock.adjust("5 minutes");
        yield* api.readAccounts(config);
        expect(
          test.requests.filter(
            (request) => request.body?.auth_index === "a" && request.body.url?.endsWith("/usage"),
          ),
        ).toHaveLength(2);
      }),
  );

  it.effect("drops only the disproven credit balance after no_credit", () =>
    Effect.gen(function* () {
      let consumed = false;
      const test = fixture({
        upstream: (request) => {
          if (request.url?.endsWith("/consume")) {
            consumed = true;
            return { status: 200, body: { code: "no_credit" } };
          }
          if (request.url?.endsWith("/rate-limit-reset-credits")) {
            return request.auth_index === "b"
              ? { status: 503, body: {} }
              : { status: 200, body: { credits: consumed ? [] : [credit("first")] } };
          }
          return { status: 200, body: { plan_type: "pro", rate_limit: null } };
        },
      });
      const api = yield* test.api;
      const initial = yield* api.readAccounts(config);
      expect(initial[0]?.usageLimits.resetCredits?.availableCount).toBe(1);
      expect(yield* api.consume(config, "first.json", "first")).toEqual({ outcome: "noCredit" });
      const refreshed = yield* api.readAccounts(config);
      expect(refreshed[0]?.usageLimits.resetCredits?.availableCount).toBe(0);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        0,
      );
      expect(test.requests.filter((request) => request.body?.url?.endsWith("/usage"))).toHaveLength(
        2,
      );
      expect(
        test.requests
          .filter((request) => request.body?.url?.endsWith("/rate-limit-reset-credits"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["a", "b", "a"]);
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
