import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";

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
const claudeAccounts = accounts.map((account) => ({
  ...account,
  provider: "claude",
  email: "same@example.com",
}));
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
    accounts?: Array<(typeof accounts)[number] & { disabled?: boolean }>;
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
      expect(path).toBe("/v0/management/api-call");
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
        accounts: [claudeAccounts[0]!],
        upstream: () => ({
          status: 200,
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

  it.effect("keeps Claude hub accounts with one email in their own organizations", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: claudeAccounts,
        upstream: (request) => ({
          status: 200,
          body: request.url?.endsWith("/profile")
            ? { organization: { uuid: request.auth_index === "a" ? " org-max " : "org-team" } }
            : { five_hour: { utilization: request.auth_index === "a" ? 20 : 80, resets_at: null } },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result.map((account) => [account.workspaceId, account.usageLimits.windows[0]?.usedPercent]),
      ).toEqual([
        ["org-max", 20],
        ["org-team", 80],
      ]);
    }),
  );

  it.effect.each([
    { status: 403, body: { token: "do-not-publish" } },
    { status: 429, body: {} },
    { status: 200, body: { organization: { uuid: "   " } } },
  ])("keeps both same-email quotas when one organization lookup fails: %j", (profile) =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: claudeAccounts,
        upstream: (request) =>
          request.url?.endsWith("/profile")
            ? request.auth_index === "a"
              ? { status: 200, body: { organization: { uuid: "org-max" } } }
              : profile
            : {
                status: 200,
                body: {
                  five_hour: { utilization: request.auth_index === "a" ? 20 : 80, resets_at: null },
                },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      const pooled = collectLimitAccounts(
        new Map([
          [
            EnvironmentId.make("env-a"),
            {
              entry: { target: { label: "Test" } },
              serverConfig: {
                usageLimitSources: [
                  {
                    id: UsageLimitSourceId.make("hub"),
                    label: "hub",
                    kind: "cliproxy",
                    checkedAt: result[0]!.usageLimits.checkedAt,
                    accounts: result,
                  },
                ],
              },
            },
          ],
        ]),
      );
      expect(result.map((account) => account.workspaceId)).toEqual(["org-max", undefined]);
      expect(pooled.map((account) => account.limits.windows[0]?.usedPercent)).toEqual([20, 80]);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect.each([
    { status: 403, body: { token: "do-not-publish" } },
    { status: 200, body: { organization: { uuid: "   " } } },
  ])("keeps Claude quota visible when organization identity is unavailable: %j", (profile) =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [claudeAccounts[0]!],
        upstream: (request) =>
          request.url?.endsWith("/profile")
            ? profile
            : { status: 200, body: { five_hour: { utilization: 12, resets_at: null } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.workspaceId).toBeUndefined();
      expect(result[0]?.usageLimits.unavailable).toBeUndefined();
      expect(result[0]?.usageLimits.windows).toMatchObject([{ usedPercent: 12 }]);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("retains Claude organization identity when the quota probe fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [claudeAccounts[0]!],
        upstream: (request) =>
          request.url?.endsWith("/profile")
            ? { status: 200, body: { organization: { uuid: "org-team" } } }
            : { status: 503, body: {} },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.workspaceId).toBe("org-team");
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect("does not reuse the last Claude organization through a failed profile lookup", () =>
    Effect.gen(function* () {
      let profileStatus = 200;
      const test = fixture({
        accounts: [claudeAccounts[0]!],
        upstream: (request) =>
          request.url?.endsWith("/profile")
            ? { status: profileStatus, body: { organization: { uuid: "org-team" } } }
            : { status: 200, body: { five_hour: { utilization: 12, resets_at: null } } },
      });
      const api = yield* test.api;
      yield* api.readAccounts(config);
      profileStatus = 429;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.workspaceId).toBeUndefined();
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
    }),
  );

  it.effect.each(["a", "replacement"])(
    "does not inherit organization identity when an auth file is replaced: %s",
    (authIndex) =>
      Effect.gen(function* () {
        const currentAccounts = [claudeAccounts[0]!];
        let profileStatus = 200;
        const test = fixture({
          accounts: currentAccounts,
          upstream: (request) =>
            request.url?.endsWith("/profile")
              ? { status: profileStatus, body: { organization: { uuid: "old-organization" } } }
              : { status: 200, body: { five_hour: { utilization: 80, resets_at: null } } },
        });
        const api = yield* test.api;
        expect((yield* api.readAccounts(config))[0]?.workspaceId).toBe("old-organization");
        currentAccounts.length = 0;
        expect(yield* api.readAccounts(config)).toEqual([]);
        currentAccounts.push({ ...claudeAccounts[0]!, auth_index: authIndex });
        profileStatus = 429;
        const replacement = yield* api.readAccounts(config);
        expect(replacement[0]?.usageLimits.windows[0]?.usedPercent).toBe(80);
        expect(replacement[0]?.workspaceId).toBeUndefined();
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

  it.effect.each([
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
    ["already_redeemed", "alreadyRedeemed"],
  ] as const)("reports %s accurately", ([code, outcome]) =>
    Effect.gen(function* () {
      const test = fixture({ upstream: () => ({ status: 200, body: { code } }) });
      const api = yield* test.api;
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({ outcome });
      expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(
        code === "already_redeemed",
      );
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
