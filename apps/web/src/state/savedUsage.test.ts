import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageBucket,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  loadSavedUsage,
  pickSavedUsage,
  type SavedUsage,
  trimSavedUsage,
  saveUsage,
} from "./savedUsage";

const bucket = (day: string, hourStart?: string): UsageBucket => ({
  day: UsageDay.make(day),
  ...(hourStart === undefined ? {} : { hourStart }),
  provider: "claude",
  model: "claude-opus-5-5",
  totals: {
    uncachedInputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: 1,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
});

const source = (homePath: string) => ({
  fingerprint: {
    hostId: "mac",
    provider: "claude" as const,
    resolvedHomePath: homePath,
    volumeId: "v",
  },
  status: "ok" as const,
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
});

const summary = (buckets: readonly UsageBucket[], readAt: string): UsageSummary => ({
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt,
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-30"),
  buckets,
  sources: [source("/home/a/.claude")],
  pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
  scanDurationMs: 1,
});

const days = (sinceDay: string, untilDay: string): UsageSummaryInput => ({
  sinceDay: UsageDay.make(sinceDay),
  untilDay: UsageDay.make(untilDay),
  timeZone: "UTC",
  resolution: "day",
});

const hours = (sinceDay: string, untilDay: string): UsageSummaryInput => ({
  ...days(sinceDay, untilDay),
  resolution: "hour",
  sinceTime: `${sinceDay}T00:00:00.000Z`,
  untilTime: `${untilDay}T12:00:00.000Z`,
});

const month: SavedUsage = {
  input: days("2026-09-01", "2026-09-30"),
  summary: summary(
    [bucket("2026-09-01"), bucket("2026-09-24"), bucket("2026-09-30")],
    "2026-09-30T10:00:00Z",
  ),
};
const week: SavedUsage = {
  input: hours("2026-09-24", "2026-09-30"),
  summary: summary([bucket("2026-09-24", "2026-09-24T09:00:00.000Z")], "2026-09-30T14:00:00Z"),
};

describe("pickSavedUsage", () => {
  it("does not use a partially overlapping saved read for a wider window", () => {
    const oneDay: SavedUsage = {
      input: days("2026-09-30", "2026-09-30"),
      summary: {
        ...summary([bucket("2026-09-30")], "2026-09-30T10:00:00Z"),
        sinceDay: UsageDay.make("2026-09-30"),
        sources: [{ ...source("/home/a/.claude"), distinctSessions: 100 }],
      },
    };
    expect(pickSavedUsage([oneDay], month.input)).toBeNull();
  });

  it("answers an exact saved window", () => {
    const picked = pickSavedUsage([week, month], month.input);
    expect(picked?.buckets.map((entry) => entry.day)).toEqual([
      "2026-09-01",
      "2026-09-24",
      "2026-09-30",
    ]);
    expect(picked?.readAt).toBe("2026-09-30T10:00:00Z");
  });

  it("answers hours only with the exact hourly window", () => {
    const sameGrid = pickSavedUsage([month, week], hours("2026-09-24", "2026-09-30"));
    expect(sameGrid?.buckets.map((entry) => entry.hourStart)).toEqual(["2026-09-24T09:00:00.000Z"]);
    // A daily read and another hourly window do not answer it.
    expect(pickSavedUsage([month], hours("2026-09-24", "2026-09-30"))).toBeNull();
    const shifted = { ...hours("2026-09-24", "2026-09-30"), sinceTime: "2026-09-24T00:30:00.000Z" };
    expect(pickSavedUsage([week], shifted)).toBeNull();
  });

  it("finds nothing outside the saved days, in another time zone, or under another model filter", () => {
    expect(pickSavedUsage([month], days("2026-10-01", "2026-10-07"))).toBeNull();
    expect(
      pickSavedUsage([month], { ...days("2026-09-01", "2026-09-30"), timeZone: "Asia/Tokyo" }),
    ).toBeNull();
    const filter = { exclude: [{ model: "claude-opus-5-5" }] };
    const filtered = { ...days("2026-09-01", "2026-09-30"), modelFilter: filter };
    expect(pickSavedUsage([month], filtered)).toBeNull();
    expect(
      pickSavedUsage([{ ...month, input: filtered }], days("2026-09-01", "2026-09-30")),
    ).toBeNull();
    expect(pickSavedUsage([{ ...month, input: filtered }], filtered)).not.toBeNull();
  });
});

describe("trimSavedUsage", () => {
  const pathed = (path: string, costUsd = 1) => ({
    ...bucket("2026-09-24"),
    sourcePath: path,
    costUsd,
  });
  const read = (
    readAt: string,
    paths: readonly string[],
    buckets: readonly UsageBucket[],
  ): UsageSummary => ({ ...summary(buckets, readAt), sources: paths.map(source) });
  const paths = (entry: UsageSummary | undefined) =>
    entry?.sources.map((item) => item.fingerprint.resolvedHomePath);

  it("leaves a folder a live read answered for to that read", () => {
    const saved = read("2026-09-30T10:00:00Z", ["/a", "/b"], [pathed("/a"), pathed("/b")]);
    const trimmed = trimSavedUsage(
      [read("2026-10-01T10:00:00Z", ["/a"], [])],
      new Map([["x", saved]]),
    );
    expect(paths(trimmed.get("x"))).toEqual(["/b"]);
    expect(trimmed.get("x")?.buckets.map((entry) => entry.sourcePath)).toEqual(["/b"]);
  });

  it("drops a provider's buckets without a path when any of its folders goes", () => {
    const saved = read("2026-09-30T10:00:00Z", ["/a", "/b"], [bucket("2026-09-24")]);
    const trimmed = trimSavedUsage(
      [read("2026-10-01T10:00:00Z", ["/a"], [])],
      new Map([["x", saved]]),
    );
    expect(paths(trimmed.get("x"))).toEqual([]);
    expect(trimmed.get("x")?.buckets).toEqual([]);
  });

  it("keeps a folder two saved reads share in the newer one only", () => {
    const older = read("2026-09-30T10:00:00Z", ["/a"], [pathed("/a", 10)]);
    const newer = read("2026-09-30T11:00:00Z", ["/a"], [{ ...pathed("/a", 10), model: "alias" }]);
    const trimmed = trimSavedUsage(
      [],
      new Map([
        ["old", older],
        ["new", newer],
      ]),
    );
    expect(paths(trimmed.get("new"))).toEqual(["/a"]);
    expect(trimmed.get("old")?.buckets).toEqual([]);
  });

  it("does not let a newer saved read that failed take a folder", () => {
    const good = read("2026-09-30T10:00:00Z", ["/a"], [pathed("/a", 10)]);
    const newer = read("2026-09-30T11:00:00Z", ["/a"], []);
    const failed = {
      ...newer,
      sources: newer.sources.map((item) => ({ ...item, status: "failed" as const })),
    };
    const trimmed = trimSavedUsage(
      [],
      new Map([
        ["good", good],
        ["failed", failed],
      ]),
    );
    expect(trimmed.get("good")?.buckets).toHaveLength(1);
  });

  it("does not let a failed live read take a folder", () => {
    const failed = { ...read("2026-10-01T10:00:00Z", ["/a"], []) };
    const live = {
      ...failed,
      sources: failed.sources.map((item) => ({ ...item, status: "failed" as const })),
    };
    const saved = read("2026-09-30T10:00:00Z", ["/a"], [pathed("/a")]);
    expect(paths(trimSavedUsage([live], new Map([["x", saved]])).get("x"))).toEqual(["/a"]);
  });
});

describe("saveUsage", () => {
  it("reports failed storage opens and allows the same read to be retried", async () => {
    const open = vi.fn(() => {
      const request = Object.assign(new EventTarget(), { error: new Error("storage unavailable") });
      queueMicrotask(() => request.dispatchEvent(new Event("error")));
      return request;
    });
    vi.stubGlobal("indexedDB", { open });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await saveUsage("env", month)).toBe(false);
      expect(await saveUsage("env", month)).toBe(false);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("keeps reads of one window under different model filters side by side", async () => {
    const stored = new Map<string, unknown>();
    const succeed = (result: unknown, then?: () => void) => {
      const request = Object.assign(new EventTarget(), { result });
      queueMicrotask(() => {
        request.dispatchEvent(new Event("success"));
        if (then) queueMicrotask(then);
      });
      return request;
    };
    const database = {
      transaction: () => {
        const transaction: EventTarget & { objectStore?: () => unknown } = new EventTarget();
        const complete = () => transaction.dispatchEvent(new Event("complete"));
        transaction.objectStore = () => ({
          get: (key: string) => succeed(stored.get(key), complete),
          put: (value: unknown, key: string) => stored.set(key, structuredClone(value)),
        });
        return transaction;
      },
    };
    vi.stubGlobal("indexedDB", { open: () => succeed(database) });
    try {
      const filtered = { ...month.input, modelFilter: { exclude: [{ model: "claude-opus-5-5" }] } };
      expect(await saveUsage("env", month)).toBe(true);
      expect(await saveUsage("env", { ...month, input: filtered })).toBe(true);
      const saved = await loadSavedUsage("env");
      expect(saved.map((entry) => entry.input.modelFilter ?? null)).toEqual([
        filtered.modelFilter,
        null,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
