import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { UsageLimitSourceError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "../../usage/cliproxyApi.ts";
import { managementTimeout } from "./claudeHub.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const codex = {
  id: "first.json",
  auth_index: "a",
  provider: "codex",
  email: "first@example.com",
  id_token: { chatgpt_account_id: "account-a" },
};
const claude = { ...codex, provider: "claude", organization_uuid: "org-1" };
type HubAccount = typeof codex & { disabled?: boolean; organization_uuid?: string };

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

function fixture(options: {
  accounts: ReadonlyArray<HubAccount>;
  upstream?: (request: RequestBody) => { status: number; body: unknown };
  redeemDelay?: Duration.Input;
}) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      if (path.endsWith("/auth-files")) {
        return HttpClientResponse.fromWeb(request, Response.json({ files: options.accounts }));
      }
      // A hub without upstream's per-account model list.
      if (path.endsWith("/auth-files/models")) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
      }
      if (path.endsWith("/reset-quota")) {
        return HttpClientResponse.fromWeb(request, Response.json({}));
      }
      const upstream = options.upstream?.(body!) ?? { status: 200, body: {} };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    }).pipe(
      Effect.delay(
        request.method === "POST" && request.url.endsWith("/api-call")
          ? (options.redeemDelay ?? 0)
          : 0,
      ),
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

describe("Claude through a CLIProxyAPI hub", () => {
  it.effect("reads Claude reset credits with the account's usage", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-31T12:00:00Z"));
      const test = fixture({
        accounts: [claude],
        upstream: () => ({
          status: 200,
          body: {
            cedar_ember: {
              eligible: true,
              next_grant_id: "grant_a",
              grants: [
                {
                  id: "grant_a",
                  resets_left: 1,
                  usable_now: true,
                  ends_at: "2099-01-01T00:00:00Z",
                },
                { id: "grant_b", resets_left: 2, usable_now: true },
              ],
            },
            five_hour: { utilization: 10, resets_at: null },
          },
        }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(result[0]?.usageLimits.resetCredits).toEqual({
        availableCount: 3,
        nextCreditId: "grant_a",
        nextExpiresAt: "2099-01-01T00:00:00.000Z",
        options: [
          {
            availableCount: 3,
            creditId: "grant_a",
            description: "Refills your 5-hour and weekly limits.",
            expiresAt: "2099-01-01T00:00:00.000Z",
            label: "Full reset",
          },
        ],
      });
      expect(test.requests.find((request) => request.body?.url)?.body?.url).toBe(
        "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
      );
    }),
  );

  it.effect("keeps the time of a reading the hub served from its cache", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-03T14:00:00Z"));
      const fetched_at = "2026-11-03T11:24:32Z";
      const test = fixture({
        accounts: [claude, { ...codex, id: "second.json", auth_index: "b" }],
        upstream: (request) => ({
          status: 200,
          body: request.url?.includes("anthropic")
            ? { five_hour: { utilization: 10, resets_at: null }, fetched_at }
            : request.url?.endsWith("/usage")
              ? { rate_limit: { primary_window: { used_percent: 12 } }, fetched_at }
              : { credits: [] },
        }),
      });
      const api = yield* test.api;
      const accounts = yield* api.readAccounts(config);
      expect(
        accounts.map((account) => account.usageLimits.windows.map((window) => window.readAt)),
      ).toEqual([["2026-11-03T11:24:32.000Z"], ["2026-11-03T11:24:32.000Z"]]);
      expect(accounts[0]?.usageLimits.checkedAt).toBe("2026-11-03T14:00:00.000Z");
      const login = yield* api.claude.usage(config, claude);
      expect(login.readAt).toBe("2026-11-03T11:24:32.000Z");
    }),
  );

  it.effect("leaves the reading time out when the hub sends none", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [claude],
        upstream: () => ({
          status: 200,
          body: { five_hour: { utilization: 10, resets_at: null } },
        }),
      });
      const [account] = yield* (yield* test.api).readAccounts(config);
      expect(account?.usageLimits.windows[0]).not.toHaveProperty("readAt");
    }),
  );

  it.effect("finds a Claude login only by its exact email and organization", () =>
    Effect.gen(function* () {
      const login = { email: "FIRST@example.com", organizationId: "org-1" };
      const hub = Effect.succeed(config);
      const unreadable = Effect.fail(new UsageLimitSourceError({ detail: "unreadable key" }));
      for (const [hubAccounts, expected] of [
        [[{ ...claude, organization_uuid: "org-2" }, claude], "first.json"],
        [[{ ...claude, organization_uuid: "org-2" }], undefined],
        [[{ ...codex, provider: "claude" }], undefined],
        [[{ ...claude, disabled: true }], undefined],
        [[claude, { ...claude, id: "copy.json" }], undefined],
      ] as const) {
        const api = yield* fixture({ accounts: hubAccounts }).api;
        expect((yield* api.claude.findLogin([hub], login))?.account.id).toBe(expected);
      }
      const earlier = yield* fixture({ accounts: [claude] }).api;
      expect((yield* earlier.claude.findLogin([hub, unreadable], login))?.account.id).toBe(
        "first.json",
      );
      const test = fixture({ accounts: [claude] });
      const api = yield* test.api;
      expect(
        yield* api.claude.findLogin([unreadable], { ...login, organizationId: undefined }),
      ).toBeUndefined();
      expect(test.requests).toEqual([]);
      const unreachable = yield* makeCliproxyApi.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            ),
          ),
        ),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(unreachable.claude.findLogin([hub], login));
      expect(error._tag).toBe("UsageLimitSourceError");
    }),
  );

  it.effect("redeems a Claude reset for the account's own organization", () =>
    Effect.gen(function* () {
      const answer = (status: number, body: unknown) =>
        fixture({ accounts: [claude], upstream: () => ({ status, body }) });
      for (const [status, body, outcome, clearsCooldown] of [
        [200, { result: "reset" }, "reset", true],
        [200, { result: "already_used" }, "alreadyRedeemed", true],
        [200, { result: "not_limited" }, "nothingToReset", false],
        [200, { result: "ineligible" }, "noCredit", false],
      ] as const) {
        const test = answer(status, body);
        expect(yield* (yield* test.api).consume(config, "first.json", "grant_a")).toEqual({
          outcome,
        });
        const redemption = test.requests.find((request) => request.body?.url);
        expect(redemption?.body?.url).toBe(
          "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
        );
        expect(redemption?.body?.method).toBe("POST");
        expect(redemption?.body?.header?.["Content-Type"]).toBe("application/json");
        expect(JSON.parse(redemption?.body?.data ?? "")).toEqual({
          program: "cedar_ember",
          grant_id: "grant_a",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
        expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(
          clearsCooldown,
        );
      }
      const twice = answer(200, { result: "reset" });
      const api = yield* twice.api;
      yield* api.consume(config, "first.json", "grant_a");
      yield* api.consume(config, "first.json", "grant_a");
      const requestIds = twice.requests.flatMap((request) =>
        request.body?.data ? [JSON.parse(request.body.data).request_id] : [],
      );
      expect(new Set(requestIds).size).toBe(2);
      for (const [status, body, detail] of [
        [200, { result: "cooldown" }, "Claude resets are cooling down. Try again later."],
        [
          200,
          { result: "unavailable" },
          "Claude could not confirm the reset. If you are still limited in a moment, try again.",
        ],
        [429, {}, "Claude is rate limiting resets. Try again soon."],
        [403, { error: "organization mismatch" }, "Sign in to Claude again to redeem resets."],
        [502, {}, "Claude could not redeem the reset."],
      ] as const) {
        const test = answer(status, body);
        const error = yield* Effect.flip(
          (yield* test.api).consume(config, "first.json", "grant_a"),
        );
        expect(error.detail).toBe(detail);
        expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(false);
      }
    }),
  );

  it.effect("waits longer for a redeem than for a read", () =>
    Effect.gen(function* () {
      for (const account of [codex, claude]) {
        const api = yield* fixture({
          accounts: [account],
          upstream: (request) => ({
            status: 200,
            body: request.url?.endsWith("/consume") ? { code: "reset" } : { result: "reset" },
          }),
          redeemDelay: "29 seconds",
        }).api;
        const redeem = yield* Effect.forkChild(api.consume(config, "first.json", "grant_a"));
        yield* TestClock.adjust("29 seconds");
        expect((yield* Fiber.join(redeem)).outcome).toBe("reset");
      }
      const postedRead = { auth_index: "a", url: "https://example.com/quota", data: "{}" };
      expect(managementTimeout(postedRead)).toBe("15 seconds");
    }),
  );

  it.effect("refuses a Claude redemption without an organization or with a malformed grant", () =>
    Effect.gen(function* () {
      for (const [account, grantId] of [
        [{ ...codex, provider: "claude" }, "grant_a"],
        [{ ...claude, organization_uuid: " " }, "grant_a"],
        [claude, "Bad Grant"],
      ] as const) {
        const test = fixture({ accounts: [account] });
        const result = yield* (yield* test.api)
          .consume(config, "first.json", grantId)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
      }
    }),
  );
});
