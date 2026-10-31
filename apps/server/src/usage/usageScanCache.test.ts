import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  makeScanCacheWriter,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { initialCodexScanState, parseCodexLine } from "../provider/Drivers/codexUsage.ts";

const encodeScanCache = (cache: ScanCache) => JSON.parse(makeScanCacheWriter()(cache, {}));

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    state: null,
    ...overrides,
  };
}

function cacheWith(entries: readonly [string, number, readonly UsageRecord[]][]): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
      tailRecords: [],
      malformedRecords: 0,
      cwd: null,
      label: null,
      position: position(),
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("restores cached history unchanged except for Claude local placeholders", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5-5", speed: "fast" })],
      ],
      [
        "/b.jsonl",
        200,
        [
          record({
            sessionId: "session-b",
            reportedCostUsd: 1.5,
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
            },
          }),
        ],
      ],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      malformedRecords: 2,
      mtimeMs: 300,
      provider: "grok",
      cwd: null,
      label: null,
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
        record({ provider: "grok", model: "<synthetic>", dedupeKey: "s:p:<synthetic>" }),
      ],
      tailRecords: [record({ provider: "grok", model: "<synthetic>", dedupeKey: null })],
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    const state = initialCodexScanState();
    for (const line of [
      { type: "session_meta", payload: { id: "session-c", model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "native-turn" } },
      {
        type: "event_msg",
        timestamp: "2026-08-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 1, output_tokens: 2 } },
        },
      },
    ])
      parseCodexLine(JSON.stringify(line), state);
    const pending = {
      ...record({
        provider: "codex",
        model: "gpt-6-astra",
        sessionId: "session-c",
        dedupeKey: null,
      }),
      unresolvedServiceTierTurnId: "native-turn",
    };
    const pendingTail = { ...pending, unresolvedServiceTierTurnId: "native-tail" };
    original.set("/codex.jsonl", {
      size: 80,
      malformedRecords: 3,
      mtimeMs: 400,
      provider: "codex",
      cwd: null,
      label: null,
      records: [
        record({
          provider: "codex",
          model: "gpt-6-astra",
          rateModel: "gpt-6",
          dedupeKey: null,
          speed: "ultrafast",
        }),
        pending,
      ],
      tailRecords: [pendingTail],
      position: position({ state }),
    });

    original.set("/a.jsonl", {
      ...original.get("/a.jsonl")!,
      tailRecords: [record({ dedupeKey: "msg_tail:" })],
    });
    const claude = original.get("/a.jsonl")!;
    const cached = new Map(original);
    cached.set("/a.jsonl", {
      ...claude,
      records: [...claude.records, record({ model: "<synthetic>" })],
      tailRecords: [
        ...claude.tailRecords,
        record({ model: "<synthetic>", dedupeKey: "msg_tail:" }),
      ],
    });
    const restored = decodeScanCache(
      JSON.parse(makeScanCacheWriter()(cached, {})),
      TEST_FORMAT_MAP,
    );

    expect(restored.size).toBe(4);
    expect(restored).toEqual(original);
  });

  it("roundtrips the session folder and subagent label", () => {
    const original = cacheWith([["/agent.jsonl", 100, [record()]]]);
    original.set("/agent.jsonl", {
      ...original.get("/agent.jsonl")!,
      cwd: "/work/app",
      label: "Map APIs",
    });
    expect(
      decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))), TEST_FORMAT_MAP),
    ).toEqual(original);
  });

  it.each([5, 6, 7, 8, 9, 10])(
    "retains v%s history while re-reading folder metadata and Codex provenance",
    (version) => {
      const original = cacheWith([["/gone.jsonl", 100, [record({ speed: "fast" })]]]);
      original.set("/gone-codex.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "codex",
        malformedRecords: 1,
        records: [record({ provider: "codex", speed: "fast", dedupeKey: null })],
        position: position({
          state: { ...initialCodexScanState(), model: "gpt-6-astra", sawSessionMeta: true },
        }),
      });
      original.set("/gone-pi.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "pi",
        records: [record({ provider: "pi", model: "anthropic/claude-fable-5" })],
        malformedRecords: 3,
        position: position({ state: { sessionId: "session-a" } }),
      });
      original.set("/grok.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "grok",
        records: [record({ provider: "grok", model: "grok-4.5-build" })],
        position: position(),
      });
      const encoded = encodeScanCache(original);
      const restored = decodeScanCache({ ...encoded, version }, TEST_FORMAT_MAP);
      for (const path of ["/gone.jsonl", "/gone-codex.jsonl", "/gone-pi.jsonl"]) {
        expect(restored.get(path)).toEqual({
          ...original.get(path),
          size: -1,
          position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
        });
      }
      expect(restored.get("/grok.jsonl")).toEqual(original.get("/grok.jsonl"));
      // A format without folder metadata can keep main's compatible v6 reducer state.
      const { workingDirectory: _folder, ...withoutFolder } = TEST_FORMAT_MAP.get("pi")!;
      const formats = new Map(TEST_FORMAT_MAP).set("pi", withoutFolder);
      const compatible = decodeScanCache({ ...encoded, version }, formats);
      expect(compatible.get("/gone-pi.jsonl")).toEqual(
        version >= 6 ? original.get("/gone-pi.jsonl") : restored.get("/gone-pi.jsonl"),
      );
    },
  );

  it("preserves folder attribution from the earlier v7 writer without its Codex tier state", () => {
    const original = cacheWith([
      ["/codex.jsonl", 100, [record({ provider: "codex", model: "gpt-6-astra", dedupeKey: null })]],
    ]);
    const {
      modelProvider: _provider,
      turnId: _turn,
      sawThreadSettings: _settings,
      ...previousState
    } = initialCodexScanState();
    original.set("/codex.jsonl", {
      ...original.get("/codex.jsonl")!,
      provider: "codex",
      cwd: "/work/project",
      label: "Inspect project",
      position: position({
        state: { ...previousState, model: "gpt-6-astra", sawSessionMeta: true },
      }),
    });
    const restored = decodeScanCache({ ...encodeScanCache(original), version: 7 }, TEST_FORMAT_MAP);
    expect(restored.get("/codex.jsonl")).toEqual({
      ...original.get("/codex.jsonl"),
      size: -1,
      position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
    });
  });

  it("re-parses a Claude transcript cached before advisor usage was counted", () => {
    const original = cacheWith([["/claude.jsonl", 100, [record()]]]);
    const v9 = { ...JSON.parse(makeScanCacheWriter()(original, {})), version: 9 };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(v9)), TEST_FORMAT_MAP);
    expect(restored.get("/claude.jsonl")).toEqual({
      ...original.get("/claude.jsonl"),
      size: -1,
      position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
    });
  });

  it("drops an entry whose persisted parse state is corrupt", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": { ...encoded.files["/a.jsonl"]!, cs: { model: 42 } },
      },
    };

    expect(
      decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP).has("/a.jsonl"),
    ).toBe(false);
  });

  it("drops an entry whose guard length is outside the supported range", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, gl: 1e20 } },
    };

    expect(
      decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP).has("/a.jsonl"),
    ).toBe(false);
  });

  it("drops an entry whose speed is not a known index", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record({ speed: "fast" })]]]));
    const row = encoded.files["/a.jsonl"]!.r[0]!;
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, r: [[...row.slice(0, 10), true]] } },
    };

    expect(
      decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP).has("/a.jsonl"),
    ).toBe(false);
  });

  it("rejects a document from before records carried a speed", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const previous = { ...encoded, version: 3 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previous)), TEST_FORMAT_MAP).size).toBe(0);
  });

  it.each([8, 9])("preserves compatible v%s Codex positions without folder metadata", (version) => {
    const { workingDirectory: _folder, ...withoutFolder } = TEST_FORMAT_MAP.get("codex")!;
    const formats = new Map(TEST_FORMAT_MAP).set("codex", withoutFolder);
    for (const malformedRecords of [0, 1]) {
      const original = cacheWith([
        ["/gone.jsonl", 100, [record({ provider: "codex", dedupeKey: null })]],
      ]);
      original.set("/gone.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "codex",
        malformedRecords,
        cwd: "/saved/project",
        label: "Saved agent",
        position: position({ state: initialCodexScanState() }),
      });
      const restored = decodeScanCache({ ...encodeScanCache(original), version }, formats);
      const resets = version === 8 && malformedRecords > 0;
      expect(restored.get("/gone.jsonl")).toEqual({
        ...original.get("/gone.jsonl"),
        ...(resets
          ? { size: -1, position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null } }
          : {}),
      });
    }
  });

  it("rewrites only changed entries and still restores the whole cache", () => {
    const write = makeScanCacheWriter();
    const cache = cacheWith([
      ["/a.jsonl", 100, [record()]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b" })]],
    ]);
    cache.set("/b.jsonl", { ...cache.get("/b.jsonl")!, malformedRecords: 2 });
    const sources = { "claude\u0000/projects": { dir: "/projects", volumeId: "1:2" } };
    expect(decodeScanCache(JSON.parse(write(cache, { sources })), TEST_FORMAT_MAP)).toEqual(cache);

    cache.set("/b.jsonl", {
      ...cache.get("/b.jsonl")!,
      size: 30,
      malformedRecords: 4,
      records: [record({ sessionId: "session-c", model: "claude-opus-5-5", dedupeKey: "msg_3:" })],
    });
    const document = JSON.parse(write(cache, { sources }));
    expect(decodeScanCache(document, TEST_FORMAT_MAP)).toEqual(cache);
    expect(document.sources).toEqual(sources);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    expect(decodeScanCache(null, TEST_FORMAT_MAP).size).toBe(0);
    expect(decodeScanCache("nonsense", TEST_FORMAT_MAP).size).toBe(0);
    expect(
      decodeScanCache({ version: 999, models: [], sessions: [], files: {} }, TEST_FORMAT_MAP).size,
    ).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = JSON.parse(
      makeScanCacheWriter()(cacheWith([["/good.jsonl", 100, [record()]]]), {}),
    );
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)), TEST_FORMAT_MAP);
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    const encoded = JSON.parse(
      makeScanCacheWriter()(
        cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
        {},
      ),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP);
    expect(restored.has("/a.jsonl")).toBe(false);
  });
});
