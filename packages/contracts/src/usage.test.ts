import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray } from "./baseSchemas.ts";
import {
  USAGE_CONTRACT_VERSION,
  UsageBucket,
  UsageSource,
  UsageSourceFingerprint,
  UsageSummary,
  type UsageProviderKind,
} from "./usage.ts";

const decodeSummary = Schema.decodeUnknownSync(UsageSummary);

// The provider literal set a client shipped with before zai; every other field is
// the current schema, so only the missing kind differs.
const legacyProvider = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
const legacySummary = Schema.Struct({
  ...UsageSummary.fields,
  buckets: ForwardCompatibleArray(
    Schema.Struct({ ...UsageBucket.fields, provider: legacyProvider }),
  ),
  sources: ForwardCompatibleArray(
    Schema.Struct({
      ...UsageSource.fields,
      fingerprint: Schema.Struct({ ...UsageSourceFingerprint.fields, provider: legacyProvider }),
    }),
  ),
});
const decodeLegacySummary = Schema.decodeUnknownSync(legacySummary);

const bucket = (provider: UsageProviderKind, model: string) => ({
  day: "2026-11-01",
  provider,
  model,
  totals: {
    uncachedInputTokens: 400,
    cachedInputTokens: 800,
    cacheCreationTokens: 0,
    outputTokens: 500,
    reasoningTokens: 0,
  },
  costUsd: 0.003,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
});
const source = (provider: UsageProviderKind) => ({
  fingerprint: {
    hostId: "host-1",
    provider,
    resolvedHomePath: "/t3/statev2.sqlite",
    volumeId: "1",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
});

const wire = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-11-05T12:00:00Z",
  timeZone: "UTC",
  sinceDay: "2026-11-01",
  untilDay: "2026-11-05",
  buckets: [bucket("claude", "claude-fable-5"), bucket("zai", "glm-5.3")],
  sources: [source("zai"), source("claude")],
  pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 12,
};

describe("usage summary providers", () => {
  it("decodes a zai bucket and source on a client that knows the kind", () => {
    const decoded = decodeSummary(wire);
    expect(decoded.buckets.map((entry) => entry.provider)).toEqual(["claude", "zai"]);
    expect(decoded.sources.map((entry) => entry.fingerprint.provider)).toEqual(["zai", "claude"]);
  });

  it("drops zai entries for a client whose provider kind lacks zai and keeps the rest", () => {
    const decoded = decodeLegacySummary(wire);
    expect(decoded.buckets.map((entry) => entry.provider)).toEqual(["claude"]);
    expect(decoded.sources.map((entry) => entry.fingerprint.provider)).toEqual(["claude"]);
    expect(decoded.contractVersion).toBe(USAGE_CONTRACT_VERSION);
    expect(decoded.pricing.knownModels).toBe(1);
    expect(decoded.buckets[0]?.model).toBe("claude-fable-5");
  });
});
