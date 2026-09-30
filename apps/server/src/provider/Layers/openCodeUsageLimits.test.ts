import * as NodeAssert from "node:assert/strict";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import {
  collectLimitPools,
  collectLimitAccounts,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";
import { readOpenCodeUsageLimits } from "./openCodeUsageLimits.ts";

const decodeUsageLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);

const probe = (body: unknown, status = 200) =>
  readOpenCodeUsageLimits({
    enabled: true,
    serverUrl: "",
    environment: { OPENCODE_AUTH_CONTENT: "{}", OPENROUTER_API_KEY: "fixture-key" },
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        NodeAssert.equal(request.url, "https://openrouter.ai/api/v1/key");
        NodeAssert.equal(request.headers.authorization, "Bearer fixture-key");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
      }),
    ),
    Effect.provide(NodeServices.layer),
  );

it.effect.each([
  { name: "zero credit limit", data: { limit: 0, limit_remaining: 0 }, percent: 100 },
  { name: "USD, not cents", data: { limit: 0.5, limit_remaining: 0.125 }, percent: 75 },
  { name: "overdrawn limit", data: { limit: 1, limit_remaining: -0.02 }, percent: 100 },
  {
    name: "remaining takes precedence",
    data: { limit: 10, limit_remaining: 7, usage: 100 },
    percent: 30,
  },
  {
    name: "daily spend",
    data: { limit: 10, limit_reset: "daily", usage: 500, usage_daily: 2 },
    percent: 20,
  },
  {
    name: "monthly spend",
    data: { limit: 10, limit_reset: "monthly", usage: 500, usage_monthly: 3 },
    percent: 30,
  },
  {
    name: "included BYOK spend",
    data: { limit: 10, usage: 2, include_byok_in_limit: true, byok_usage: 5 },
    percent: 70,
  },
  {
    name: "included weekly BYOK spend",
    data: {
      limit: 10,
      limit_reset: "weekly",
      usage_weekly: 2,
      include_byok_in_limit: true,
      byok_usage_weekly: 5,
      byok_usage: 500,
    },
    percent: 70,
  },
  {
    name: "excluded BYOK spend",
    data: { limit: 10, usage: 2, include_byok_in_limit: false, byok_usage: 5 },
    percent: 20,
  },
])("meters $name", ({ data, percent }) =>
  Effect.gen(function* () {
    const result = yield* probe({ data });
    NodeAssert.equal(result.unavailable, undefined);
    NodeAssert.equal(result.windows[0]?.usedPercent, percent);
    NodeAssert.ok(!JSON.stringify(result).includes("fixture-key"));
  }),
);

it.effect.each([
  {},
  { data: {} },
  { data: { limit: 10 } },
  { data: { limit: -1, limit_remaining: 0 } },
  { data: { limit: "fixture-key" } },
  { data: { limit: 10, usage: 100, limit_reset: "weekly" } },
  { data: { limit: 10, usage: 2, include_byok_in_limit: true } },
])("preserves the last good bars on an incomplete response: %j", (body) =>
  Effect.gen(function* () {
    const result = yield* probe(body);
    NodeAssert.equal(result.unavailable?.reason, "probeFailed");
    const published = { checkedAt: "2026-09-25T12:00:00.000Z", windows: [] };
    NodeAssert.equal(resolveUsageLimitsAfterProbe({ published, probed: result }), published);
    NodeAssert.ok(!JSON.stringify(result).includes("fixture-key"));
  }),
);

it.effect.each([200, 401, 403])("clears unavailable or rejected keys (%i)", (status) =>
  Effect.gen(function* () {
    const result = yield* probe({ data: { limit: null } }, status);
    NodeAssert.equal(result.unavailable?.reason, "unsupported");
    NodeAssert.equal(result.credentialFingerprint, undefined);
    NodeAssert.deepEqual(result.windows, []);
  }),
);

it.effect(
  "uses stored OpenRouter credentials before environment credentials and isolates identities",
  () =>
    Effect.gen(function* () {
      const fingerprints: (string | undefined)[] = [];
      for (const key of ["one", "two", "one"]) {
        const result = yield* readOpenCodeUsageLimits({
          enabled: true,
          serverUrl: "",
          environment: {
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              "opencode-go": { type: "api", key: "go" },
              openrouter: { type: "api", key },
            }),
            OPENROUTER_API_KEY: "unused-env-key",
          },
        }).pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({ readFileString: () => Effect.die("unexpected disk read") }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const isOpenRouter = request.url === "https://openrouter.ai/api/v1/key";
              NodeAssert.equal(
                request.headers.authorization,
                `Bearer ${isOpenRouter ? key : "go"}`,
              );
              const window = { percent: 20, resetsAt: "2026-09-26T00:00:00.000Z" };
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    isOpenRouter
                      ? { data: { limit: 10, limit_remaining: 8 } }
                      : { usage: { rolling: window, weekly: window, monthly: window } },
                  ),
                ),
              );
            }),
          ),
          Effect.provide(NodeServices.layer),
        );
        NodeAssert.equal(result.windows.length, 4);
        NodeAssert.ok(result.credentialFingerprint);
        fingerprints.push(result.credentialFingerprint);
      }
      NodeAssert.notEqual(fingerprints[0], fingerprints[1]);
      NodeAssert.equal(fingerprints[0], fingerprints[2]);
    }),
);

it.effect("does not request usage when credentials are missing", () =>
  Effect.gen(function* () {
    const result = yield* readOpenCodeUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { OPENCODE_AUTH_CONTENT: "{}" },
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected request")),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(result.unavailable?.reason, "unsupported");
  }),
);

it.effect.each(["timeout", "cancel"] as const)(
  "interrupts both pending account reads on %s",
  (mode) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let requests = 0;
      let interrupted = 0;
      const fiber = yield* readOpenCodeUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          OPENCODE_AUTH_CONTENT: "{}",
          OPENCODE_API_KEY: "go",
          OPENROUTER_API_KEY: "router",
        },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.gen(function* () {
              requests += 1;
              if (requests === 2) yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted += 1;
                }),
              ),
            ),
          ),
        ),
        Effect.provide(NodeServices.layer),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      if (mode === "timeout") {
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(fiber);
        NodeAssert.equal(result.unavailable?.reason, "probeFailed");
      } else {
        yield* Fiber.interrupt(fiber);
      }
      NodeAssert.equal(interrupted, 2);
    }),
);

it.effect("keeps daily and lifetime OpenRouter budgets in separate pools", () =>
  Effect.gen(function* () {
    const daily = yield* probe({ data: { limit: 10, limit_remaining: 2, limit_reset: "daily" } });
    const lifetime = yield* probe({ data: { limit: 10, limit_remaining: 8, limit_reset: null } });
    const accounts: LimitAccount[] = [daily, lifetime].map((limits, index) => ({
      key: String(index),
      driver: ProviderDriverKind.make("opencode"),
      displayName: null,
      email: undefined,
      plan: undefined,
      accentColor: undefined,
      environments: [],
      sourceLabel: null,
      redeem: null,
      limits,
    }));
    const pools = collectLimitPools(accounts, Date.parse("2026-09-25T12:00:00.000Z"));
    NodeAssert.deepEqual(
      pools[0]?.windows.map((window) => [window.label, window.usedPercent]),
      [
        ["OpenRouter · Daily", 80],
        ["OpenRouter · Credit limit", 20],
      ],
    );
  }),
);

it.effect(
  "deduplicates overlapping Go and OpenRouter accounts, including legacy Go snapshots",
  () =>
    Effect.gen(function* () {
      const presentations = new Map<
        EnvironmentId,
        { entry: { target: { label: string } }; serverConfig: { providers: ServerProvider[] } }
      >();
      for (const [id, go, router] of [
        ["a", "shared-go", "router-a"],
        ["b", "shared-go", "router-b"],
        ["c", "other-go", "router-b"],
        ["d", "shared-go", undefined],
      ] as const) {
        const usageLimits = yield* readOpenCodeUsageLimits({
          enabled: true,
          serverUrl: "",
          environment: {
            OPENCODE_AUTH_CONTENT: "{}",
            OPENCODE_API_KEY: go,
            OPENROUTER_API_KEY: router,
          },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const window = {
                percent: go === "shared-go" ? 100 : 0,
                resetsAt: "2026-10-02T00:00:00.000Z",
              };
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    request.url === "https://openrouter.ai/api/v1/key"
                      ? { data: { limit: 10, limit_remaining: 5 } }
                      : { usage: { rolling: window, weekly: window, monthly: window } },
                  ),
                ),
              );
            }),
          ),
          Effect.provide(NodeServices.layer),
        );
        const wireLimits = decodeUsageLimits(JSON.parse(JSON.stringify(usageLimits)));
        // A Go-only server predating window identities supplies the top-level fingerprint.
        const limits =
          id === "d"
            ? {
                ...wireLimits,
                windows: wireLimits.windows.map(
                  ({ credentialFingerprint: _fingerprint, ...window }) => window,
                ),
              }
            : wireLimits;
        presentations.set(EnvironmentId.make(id), {
          entry: { target: { label: id } },
          serverConfig: {
            providers: [
              {
                instanceId: ProviderInstanceId.make("opencode"),
                driver: ProviderDriverKind.make("opencode"),
                enabled: true,
                installed: true,
                version: null,
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: usageLimits.checkedAt,
                models: [],
                slashCommands: [],
                skills: [],
                usageLimits: limits,
              },
            ],
          },
        });
      }
      const pool = collectLimitPools(
        collectLimitAccounts(presentations),
        Date.parse("2026-10-01T12:00:00.000Z"),
      );
      NodeAssert.equal(
        pool[0]?.windows.find((window) => window.id === "go_rolling")?.usedPercent,
        50,
      );
      NodeAssert.equal(pool[0]?.accounts.length, 4);
      NodeAssert.deepEqual(
        pool[0]?.windows.map((window) => window.columns.length),
        [2, 2, 2, 2],
      );
      NodeAssert.equal(
        pool[0]?.windows.find((window) => window.id === "openrouter_key")?.members.length,
        2,
      );
    }),
);
