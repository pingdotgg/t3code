import { describe, expect, it } from "vitest";
import { selectThreadsToEvict, EVICTION_KEEP_COUNT, type EvictableThread } from "./threadEviction";

function makeEvictable(id: string, overrides: Partial<EvictableThread> = {}): EvictableThread {
  return {
    id,
    hydrated: true,
    isActive: false,
    hasRunningSession: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    activityCount: 0,
    ...overrides,
  };
}

describe("selectThreadsToEvict", () => {
  it("returns empty array when thread count is within keep limit", () => {
    const threads = Array.from({ length: EVICTION_KEEP_COUNT }, (_, i) => makeEvictable(`t-${i}`));
    expect(selectThreadsToEvict(threads, "t-0")).toEqual([]);
  });

  it("never evicts the active thread", () => {
    const threads = Array.from({ length: EVICTION_KEEP_COUNT + 5 }, (_, i) =>
      makeEvictable(`t-${i}`),
    );
    const result = selectThreadsToEvict(threads, "t-0");
    expect(result).not.toContain("t-0");
  });

  it("never evicts threads with running sessions", () => {
    const threads = [
      ...Array.from({ length: EVICTION_KEEP_COUNT + 3 }, (_, i) => makeEvictable(`t-${i}`)),
      makeEvictable("t-running", { hasRunningSession: true }),
    ];
    const result = selectThreadsToEvict(threads, "t-0");
    expect(result).not.toContain("t-running");
  });

  it("evicts oldest idle threads first", () => {
    const threads = [
      makeEvictable("t-old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeEvictable("t-new", { updatedAt: "2026-04-01T00:00:00.000Z" }),
      ...Array.from({ length: EVICTION_KEEP_COUNT }, (_, i) =>
        makeEvictable(`t-keep-${i}`, { updatedAt: "2026-03-01T00:00:00.000Z" }),
      ),
    ];
    const result = selectThreadsToEvict(threads, "t-new");
    expect(result).toContain("t-old");
    expect(result).not.toContain("t-new");
  });

  it("skips already-dehydrated threads", () => {
    const threads = [
      makeEvictable("t-dehydrated", { hydrated: false }),
      ...Array.from({ length: EVICTION_KEEP_COUNT + 2 }, (_, i) => makeEvictable(`t-${i}`)),
    ];
    const result = selectThreadsToEvict(threads, "t-0");
    expect(result).not.toContain("t-dehydrated");
  });
});
