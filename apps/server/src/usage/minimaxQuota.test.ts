import { expect, it } from "@effect/vitest";
import { miniMaxWindows, readMiniMaxQuota } from "./minimaxQuota.ts";

it("uses remaining percentages when counts are zero and skips inactive windows", () => {
  expect(
    miniMaxWindows({
      model_remains: [
        {
          model_name: "general",
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          current_interval_remaining_percent: 72,
          current_weekly_remaining_percent: 99,
          current_weekly_status: 3,
        },
      ],
    }),
  ).toEqual([
    { id: "general:current_interval", kind: "session", label: "general session", usedPercent: 28 },
  ]);
  expect(
    miniMaxWindows({
      model_remains: [
        {
          model_name: "MiniMax-M3",
          current_interval_total_count: 100,
          current_interval_usage_count: 80,
        },
      ],
    })[0]?.usedPercent,
  ).toBe(20);
  expect(
    miniMaxWindows({
      model_remains: [
        { model_name: "general", current_interval_total_count: 0, current_interval_usage_count: 0 },
      ],
    }),
  ).toEqual([]);
});

import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { HttpClient, HttpClientResponse } from "effect/http";

it.effect("keeps different MiniMax credentials distinct without exposing them", () =>
  Effect.gen(function* () {
    const first = (yield* readMiniMaxQuota("first-key"))[0]?.usageLimits.credentialFingerprint;
    const second = (yield* readMiniMaxQuota("second-key"))[0]?.usageLimits.credentialFingerprint;
    const repeated = (yield* readMiniMaxQuota("first-key"))[0]?.usageLimits.credentialFingerprint;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).toBe(repeated);
  }).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ model_remains: [] }))),
      ),
    ),
  ),
);

it.effect("preserves the underlying quota failure", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(readMiniMaxQuota("fixture-key"));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.cause).toBeDefined();
      expect(result.failure.detail).toBe(
        "Could not read MiniMax quota. Check the Coding Plan key and try again.",
      );
    }
  }).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
        ),
      ),
    ),
  ),
);
