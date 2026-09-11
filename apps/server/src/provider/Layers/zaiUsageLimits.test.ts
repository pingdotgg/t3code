import type { ProviderListResponse } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { resolveUsageLimitsAfterProbe } from "../providerUsageLimits.ts";
import { readOpenCodeZaiUsageLimits } from "./zaiUsageLimits.ts";

const checkedAt = "2026-09-10T12:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const reset = Date.parse("2026-09-10T17:00:00.000Z");
const providers: ProviderListResponse = {
  connected: ["zai-coding-plan"],
  default: {},
  all: [
    {
      id: "zai-coding-plan",
      name: "Z.AI Coding Plan",
      source: "api",
      env: [],
      key: "test-key",
      options: {},
      models: {},
    },
  ],
};
const limits = [
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: reset },
  { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 60, nextResetTime: reset + 604800000 },
  { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10, nextResetTime: reset },
];
const response = (items: ReadonlyArray<unknown> = limits) => ({
  code: 200,
  success: true,
  data: { limits: items },
});

function fixture(body: unknown = response(), status = 200) {
  const requests: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  return {
    requests,
    read: (inventory = providers) =>
      readOpenCodeZaiUsageLimits(inventory, checkedAt).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
  };
}

describe("OpenCode Z.ai quota", () => {
  it.effect(
    "maps the five-hour, weekly and separate MCP windows without inventing a month duration",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        const result = yield* test.read();
        expect(test.requests).toEqual(["https://api.z.ai/api/monitor/usage/quota/limit"]);
        expect(result).toEqual({
          checkedAt,
          windows: [
            {
              id: "zai_tokens_limit_3_5",
              kind: "session",
              label: "Z.ai Coding · 5h",
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: "2026-09-10T17:00:00.000Z",
            },
            {
              id: "zai_tokens_limit_6_1",
              kind: "weekly",
              label: "Z.ai Coding · 1w",
              usedPercent: 60,
              windowDurationMins: 10080,
              resetsAt: "2026-09-17T17:00:00.000Z",
            },
            {
              id: "zai_time_limit_5_1",
              kind: "other",
              label: "Z.ai MCP · 1mo",
              usedPercent: 10,
              resetsAt: "2026-09-10T17:00:00.000Z",
            },
          ],
        });
      }),
  );

  it.effect("uses OpenCode's config credential before its resolved account key", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.headers.authorization).toBe("Bearer config-key");
          return HttpClientResponse.fromWeb(request, Response.json(response()));
        }),
      );
      const result = yield* readOpenCodeZaiUsageLimits(
        {
          ...providers,
          all: [{ ...providers.all[0]!, source: "config", options: { apiKey: "config-key" } }],
        },
        checkedAt,
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(encodeJson(result)).not.toContain("config-key");
      expect(result?.windows).toHaveLength(3);
    }),
  );

  it.effect("does not request quota for disconnected or other upstream providers", () =>
    Effect.gen(function* () {
      const test = fixture();
      expect(yield* test.read({ ...providers, connected: [] })).toBeUndefined();
      expect(yield* test.read({ ...providers, connected: ["zai"] })).toBeUndefined();
      expect(test.requests).toEqual([]);
    }),
  );

  it.effect("does not guess credentials for custom endpoints, plugin auth or missing keys", () =>
    Effect.gen(function* () {
      const test = fixture();
      for (const provider of [
        { ...providers.all[0]!, key: "" },
        { ...providers.all[0]!, source: "custom" as const },
        { ...providers.all[0]!, options: { baseURL: "https://proxy.example.test/v1" } },
        { ...providers.all[0]!, options: { apiKey: "" } },
      ]) {
        expect((yield* test.read({ ...providers, all: [provider] }))?.unavailable?.reason).toBe(
          "unsupported",
        );
      }
      expect(test.requests).toEqual([]);
    }),
  );

  it.effect(
    "clamps percentages, omits invalid resets, and ignores unknown limit kinds and units",
    () =>
      Effect.gen(function* () {
        const result = yield* fixture(
          response([
            { ...limits[0]!, percentage: 120, nextResetTime: -1 },
            { ...limits[1]!, percentage: -5, nextResetTime: 1e30 },
            { ...limits[0]!, type: "FUTURE_LIMIT" },
            { ...limits[0]!, unit: 99 },
          ]),
        ).read();
        expect(result?.windows.map((window) => window.usedPercent)).toEqual([100, 0]);
        expect(result?.windows.every((window) => window.resetsAt === undefined)).toBe(true);
      }),
  );

  it.effect("does not represent an empty quota response as zero usage", () =>
    Effect.gen(function* () {
      expect((yield* fixture(response([])).read())?.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect(
    "sanitizes HTTP and application errors and preserves the last good quota after a failed refresh",
    () =>
      Effect.gen(function* () {
        const published = yield* fixture().read();
        for (const [body, status] of [
          [{ secret: "test-key" }, 401],
          [response(), 429],
          [{ code: 500, success: false, msg: "test-key" }, 200],
          [response([{ ...limits[0]!, percentage: "bad" }]), 200],
        ] as const) {
          const probed = yield* fixture(body, status).read();
          expect(probed?.unavailable?.reason).toBe("probeFailed");
          expect(encodeJson(probed)).not.toContain("test-key");
          expect(resolveUsageLimitsAfterProbe({ published, probed })).toBe(published);
        }
      }),
  );

  it.effect("bounds a stalled quota read", () =>
    Effect.gen(function* () {
      const fiber = yield* readOpenCodeZaiUsageLimits(providers, checkedAt).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(fiber))?.unavailable?.reason).toBe("probeFailed");
    }),
  );
});
