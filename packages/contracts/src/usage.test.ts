import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { UsageBucket } from "./usage.ts";

const decodeUsageBucket = Schema.decodeUnknownEffect(UsageBucket);

it.effect("defaults sourceIndex when decoding an older usage bucket", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeUsageBucket({
      day: "2026-08-07",
      provider: "claude",
      model: "claude-fable-5",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 2,
        cacheCreationTokens: 3,
        outputTokens: 4,
        reasoningTokens: 0,
      },
      costUsd: 0.01,
      cacheSavingsUsd: 0.02,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    });

    assert.strictEqual(decoded.sourceIndex, 0);
  }),
);
