import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  decodeScanIdentityCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanIdentityCache,
  pruneScanCache,
  USAGE_SCAN_CACHE_VERSION,
  type CachedFile,
  type ScanCache,
  type ScanIdentityCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    cwd: "/home/theo/project",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      cacheCreation5mTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    codexState: null,
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
      position: position(),
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("restores positive and negative transcript identities", () => {
    const identities: ScanIdentityCache = new Map([
      [
        "/target.jsonl",
        {
          size: 100,
          mtimeMs: 200,
          provider: "codex",
          sessionId: "target-session",
          cwd: "/work/target",
        },
      ],
      ["/unknown.jsonl", { size: 10, mtimeMs: 20, provider: "codex", sessionId: "", cwd: "" }],
    ]);

    const restored = decodeScanIdentityCache(
      JSON.parse(JSON.stringify(encodeScanCache(new Map(), identities))),
    );

    expect(restored).toEqual(identities);
  });

  it("restores records unchanged", () => {
    const original = cacheWith([
      ["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5" })]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b", reportedCostUsd: 1.5 })]],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
      ],
      tailRecords: [record({ provider: "grok", model: "grok-4.5-build", dedupeKey: null })],
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    original.set("/codex.jsonl", {
      size: 80,
      mtimeMs: 400,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-5.2-codex", dedupeKey: null })],
      tailRecords: [],
      position: position({
        codexState: {
          model: "gpt-5.2-codex",
          sessionId: "session-c",
          cwd: "/home/theo/codex-project",
          lastUsageSignature: '{"input_tokens":1}',
          sawSessionMeta: true,
          suppressingForkCopies: false,
          forkCopyAnchorMs: 0,
        },
      }),
    });

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.size).toBe(4);
    expect(restored.get("/a.jsonl")).toEqual(original.get("/a.jsonl"));
    expect(restored.get("/b.jsonl")).toEqual(original.get("/b.jsonl"));
    expect(restored.get("/grok.jsonl")).toEqual(original.get("/grok.jsonl"));
    expect(restored.get("/codex.jsonl")).toEqual(original.get("/codex.jsonl"));
  });

  it("preserves partial TTL classification and its unclassified remainder", () => {
    const partial = record({
      totals: {
        uncachedInputTokens: 2,
        cachedInputTokens: 10,
        cacheCreationTokens: 60,
        cacheCreation5mTokens: 20,
        cacheCreation1hTokens: 10,
        outputTokens: 12,
        reasoningTokens: 0,
      },
    });
    const original = cacheWith([["/partial.jsonl", 100, [partial]]]);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.get("/partial.jsonl")?.records[0]?.totals).toEqual(partial.totals);
  });

  it("drops an entry whose persisted parse state is corrupt", () => {
    // Resuming with a bad reducer state would attach appended usage to the
    // wrong model or replay fork-copied history; that entry must cold parse.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": { ...encoded.files["/a.jsonl"]!, cs: { model: 42 } },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("drops an entry whose guard length is outside the supported range", () => {
    // The guard length sizes a Buffer in the reader; a bogus value would make
    // every parse of that file fail and silently drop its usage.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, gl: 1e20 } },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("rejects a document from the previous cache version", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const previous = { ...encoded, version: USAGE_SCAN_CACHE_VERSION - 1 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previous))).size).toBe(0);
  });

  it("interns repeated model and session strings", () => {
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" }), record()]]]),
    );

    expect(encoded.models).toEqual(["claude-fable-5"]);
    expect(encoded.sessions).toEqual(["session-a"]);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    // A bad cache should cost one cold scan, never a broken page.
    expect(decodeScanCache(null).size).toBe(0);
    expect(decodeScanCache("nonsense").size).toBe(0);
    expect(decodeScanCache({ version: 999, models: [], sessions: [], files: {} }).size).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()]]]));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)));
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("rejects the whole cache when an intern table holds a non-string", () => {
    // models: [1] would pass the undefined guard, put a number in a record's
    // model, and crash lookupRate at aggregate time.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = { ...encoded, models: [1] };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).size).toBe(0);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    // Keeping the surviving rows under the original (size, mtime) would read
    // as a valid warm hit and the file would never be re-parsed.
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
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

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)));
    expect(restored.has("/a.jsonl")).toBe(false);
  });

  it.each([0.5, 99])("drops an entry with invalid cwd index %s", (cwdIndex) => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const row = encoded.files["/a.jsonl"]!.r[0]!;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [[...row.slice(0, 10), cwdIndex, ...row.slice(11)]],
        },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it.each([
    [20, 0],
    [-1, 11],
    [5.5, 4.5],
  ])("drops an entry with invalid cache TTL counters %s + %s", (fiveMinute, oneHour) => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const row = encoded.files["/a.jsonl"]!.r[0]!;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [[...row.slice(0, 11), fiveMinute, oneHour]],
        },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });
});

describe("pruneScanIdentityCache", () => {
  it("keeps old live identities and removes only files proven deleted", () => {
    const identities: ScanIdentityCache = new Map([
      [
        "/codex/sessions/live.jsonl",
        { size: 10, mtimeMs: 1, provider: "codex", sessionId: "live", cwd: "/work/live" },
      ],
      [
        "/codex/sessions/gone.jsonl",
        { size: 10, mtimeMs: 1, provider: "codex", sessionId: "gone", cwd: "/work/gone" },
      ],
      [
        "/other/sessions/unwalked.jsonl",
        { size: 10, mtimeMs: 1, provider: "codex", sessionId: "other", cwd: "/work/other" },
      ],
    ]);

    expect(
      pruneScanIdentityCache(identities, {
        livePaths: new Set(["/codex/sessions/live.jsonl"]),
        walkedRoots: ["/codex/sessions"],
      }),
    ).toBe(1);
    expect([...identities.keys()]).toEqual([
      "/codex/sessions/live.jsonl",
      "/other/sessions/unwalked.jsonl",
    ]);
  });
});

describe("pruneScanCache", () => {
  const retentionCutoffMs = 1000;

  it("drops entries older than retention", () => {
    const cache = cacheWith([["/old.jsonl", 500, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 400,
      retentionCutoffMs,
    });

    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("drops in-window entries whose file has disappeared", () => {
    const cache = cacheWith([["/gone.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(cache.size).toBe(0);
  });

  it("keeps entries outside the walked window that are still within retention", () => {
    // Viewing 7 days must not evict the 30-day entries, which that walk never
    // looked for and so cannot prove are gone.
    const cache = cacheWith([["/older-but-valid.jsonl", 2000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("keeps entries the walk saw", () => {
    const cache = cacheWith([["/live.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, {
      livePaths: new Set(["/live.jsonl"]),
      walkedRoots: ["/"],
      windowStartMs: 4000,
      retentionCutoffMs,
    });

    expect(cache.size).toBe(1);
  });
});

describe("pruneScanCache with an unwalked root", () => {
  it("keeps in-window entries for a provider whose directory was not walked", () => {
    // A missing provider root or failed settings read leaves livePaths without
    // that provider's files. Its warm entries must survive the pass.
    const cache = cacheWith([["/codex/sessions/a.jsonl", 5000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/claude/projects"],
      windowStartMs: 4000,
      retentionCutoffMs: 1000,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });

  it("keeps entries under a sibling path that only shares the walked root prefix", () => {
    const cache = cacheWith([["/claude/projects-copy/a.jsonl", 5000, [record()]]]);

    const removed = pruneScanCache(cache, {
      livePaths: new Set(),
      walkedRoots: ["/claude/projects"],
      windowStartMs: 4000,
      retentionCutoffMs: 1000,
    });

    expect(removed).toBe(0);
    expect(cache.size).toBe(1);
  });
});

describe("dedupeWithinFile", () => {
  it("keeps the final record per dedupe key", () => {
    const kept = dedupeWithinFile([
      record({ totals: { ...record().totals, outputTokens: 1 } }),
      record({ totals: { ...record().totals, outputTokens: 999 } }),
      record({ dedupeKey: "msg_2:" }),
    ]);

    expect(kept).toHaveLength(2);
    expect(kept[0]?.totals.outputTokens).toBe(999);
  });

  it("keeps every record that has no dedupe key", () => {
    expect(
      dedupeWithinFile([record({ dedupeKey: null }), record({ dedupeKey: null })]),
    ).toHaveLength(2);
  });
});
