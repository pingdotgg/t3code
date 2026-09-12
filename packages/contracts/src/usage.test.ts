import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { UsageBucket, UsageSummary } from "./usage.ts";

const decodeUsageBucket = Schema.decodeUnknownEffect(UsageBucket);

const legacyBucket = {
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
};

it.effect("defaults sourceIndex when decoding an older usage bucket", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeUsageBucket(legacyBucket);

    assert.strictEqual(decoded.sourceIndex, 0);
  }),
);

const decodeUsageSummary = Schema.decodeUnknownSync(UsageSummary);
const source = {
  fingerprint: {
    hostId: "host",
    provider: "claude",
    resolvedHomePath: "/home/user/.claude/projects",
    volumeId: "1:2",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
};
const summary = {
  contractVersion: 6,
  readAt: "2026-08-07T00:00:00Z",
  timeZone: "UTC",
  sinceDay: "2026-08-07",
  untilDay: "2026-08-07",
  buckets: [legacyBucket],
  sources: [source],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 0,
};

it("rejects bucket source indexes outside the summary's sources", () => {
  for (const sourceIndex of [1, 2]) {
    assert.throws(() =>
      decodeUsageSummary({ ...summary, buckets: [{ ...legacyBucket, sourceIndex }] }),
    );
  }
  assert.throws(() => decodeUsageSummary({ ...summary, sources: [] }));
});

it("decodes valid source indexes and preserves the legacy default", () => {
  assert.strictEqual(decodeUsageSummary(summary).buckets[0]?.sourceIndex, 0);
  const decoded = decodeUsageSummary({
    ...summary,
    sources: [
      source,
      {
        ...source,
        fingerprint: {
          ...source.fingerprint,
          resolvedHomePath: "/other/projects",
          volumeId: "1:3",
        },
      },
    ],
    buckets: [{ ...legacyBucket, sourceIndex: 1 }],
  });
  assert.strictEqual(decoded.buckets[0]?.sourceIndex, 1);
});

it("decodes an empty summary without sources", () => {
  const decoded = decodeUsageSummary({ ...summary, buckets: [], sources: [] });
  assert.deepStrictEqual(decoded.buckets, []);
  assert.deepStrictEqual(decoded.sources, []);
});
