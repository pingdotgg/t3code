import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const { readPreparedConnection } = vi.hoisted(() => ({
  readPreparedConnection: vi.fn<() => { httpBaseUrl: string } | null>(() => null),
}));

vi.mock("~/state/session", () => ({ readPreparedConnection }));

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  BROWSER_HISTORY_MAX_PROJECTS,
  BROWSER_HISTORY_MAX_TITLE_LENGTH,
  type BrowserHistoryEntry,
  evictExcessProjects,
  mergeBrowserHistoryState,
  migratePersistedBrowserHistoryState,
  normalizeHistoryUrl,
  recordVisitForThread,
  removeUrlForThread,
  resetBrowserHistoryForTests,
  setTitleForThreadUrl,
  upsertHistoryEntry,
  useBrowserHistoryStore,
} from "./browserHistoryStore";

function entry(overrides: Partial<BrowserHistoryEntry> = {}): BrowserHistoryEntry {
  return { url: "http://localhost:3000/", lastVisitedAt: 1000, ...overrides };
}

beforeEach(() => readPreparedConnection.mockReturnValue(null));
afterEach(() => vi.restoreAllMocks());

function spyOnPersistWrites() {
  const storage = useBrowserHistoryStore.persist.getOptions().storage;
  if (!storage) throw new Error("Browser history persistence storage is unavailable.");
  return vi.spyOn(storage, "setItem");
}

describe("normalizeHistoryUrl", () => {
  it("normalizes bare loopback hosts to http and keeps path/query", () => {
    expect(normalizeHistoryUrl("localhost:3000/admin?tab=1")).toBe(
      "http://localhost:3000/admin?tab=1",
    );
  });

  it("normalizes bare public hosts to https", () => {
    expect(normalizeHistoryUrl("myapp.test")).toBe("https://myapp.test/");
  });

  it("preserves hash routes and strips credentials", () => {
    expect(normalizeHistoryUrl("http://localhost:3000/app#/route")).toBe(
      "http://localhost:3000/app#/route",
    );
    expect(normalizeHistoryUrl("https://user:secret@example.com/")).toBe("https://example.com/");
  });

  it("rejects non-http(s), unparseable, and oversized urls", () => {
    expect(normalizeHistoryUrl("ftp://example.com")).toBeNull();
    expect(normalizeHistoryUrl("")).toBeNull();
    expect(normalizeHistoryUrl(`http://localhost/${"a".repeat(2048)}`)).toBeNull();
  });
});

describe("upsertHistoryEntry", () => {
  it("prepends new urls", () => {
    const next = upsertHistoryEntry([entry()], "http://localhost:5173/", 2000);
    expect(next.map((e) => e.url)).toEqual(["http://localhost:5173/", "http://localhost:3000/"]);
    expect(next[0]).toEqual({ url: "http://localhost:5173/", lastVisitedAt: 2000 });
  });

  it("moves revisits to front, updates the timestamp, and keeps the title", () => {
    const existing = [
      entry({ url: "http://a.test/", lastVisitedAt: 500, title: "A" }),
      entry({ url: "http://b.test/", lastVisitedAt: 400 }),
    ];
    const next = upsertHistoryEntry(existing, "http://b.test/", 3000);
    expect(next.map((e) => e.url)).toEqual(["http://b.test/", "http://a.test/"]);
    expect(next[0]?.lastVisitedAt).toBe(3000);
    expect(next[1]?.title).toBe("A");
  });

  it("caps the list at the per-project limit", () => {
    const full = Array.from({ length: BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT }, (_, i) =>
      entry({ url: `http://localhost:${3000 + i}/`, lastVisitedAt: i }),
    );
    const next = upsertHistoryEntry(full, "http://new.test/", 9999);
    expect(next).toHaveLength(BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
    expect(next[0]?.url).toBe("http://new.test/");
    const lastPort = 3000 + BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT - 1;
    expect(next.some((e) => e.url === `http://localhost:${lastPort}/`)).toBe(false);
    expect(next.some((e) => e.url === "http://localhost:3000/")).toBe(true);
  });

  it("with insertOrdered, slots an older entry below a newer one instead of prepending", () => {
    const existing = [entry({ url: "http://newer.test/", lastVisitedAt: 2000 })];
    const next = upsertHistoryEntry(existing, "http://older.test/", 1000, {
      insertOrdered: true,
    });
    expect(next.map((e) => e.url)).toEqual(["http://newer.test/", "http://older.test/"]);
  });

  it("with insertOrdered, replaying an older visit for an existing entry keeps its newer timestamp", () => {
    const existing = [entry({ url: "http://a.test/", lastVisitedAt: 2000 })];
    const next = upsertHistoryEntry(existing, "http://a.test/", 1000, { insertOrdered: true });
    expect(next).toEqual([{ url: "http://a.test/", lastVisitedAt: 2000 }]);
  });
});

describe("evictExcessProjects", () => {
  it("keeps the most recently visited projects when over the cap", () => {
    const byProjectKey = Object.fromEntries(
      Array.from({ length: BROWSER_HISTORY_MAX_PROJECTS + 2 }, (_, i) => [
        `project-${i}`,
        [entry({ lastVisitedAt: i })],
      ]),
    );
    const next = evictExcessProjects(byProjectKey);
    expect(Object.keys(next)).toHaveLength(BROWSER_HISTORY_MAX_PROJECTS);
    expect(next["project-0"]).toBeUndefined();
    expect(next["project-1"]).toBeUndefined();
    expect(next[`project-${BROWSER_HISTORY_MAX_PROJECTS + 1}`]).toBeDefined();
  });
});

describe("migratePersistedBrowserHistoryState", () => {
  it("drops malformed state and invalid entries", () => {
    expect(migratePersistedBrowserHistoryState(null)).toEqual({ byProjectKey: {} });
    expect(migratePersistedBrowserHistoryState({ byProjectKey: 42 })).toEqual({ byProjectKey: {} });
    const migrated = migratePersistedBrowserHistoryState({
      byProjectKey: {
        good: [
          { url: "http://a.test/", lastVisitedAt: 100, title: "A" },
          { url: "", lastVisitedAt: 100 },
          { url: "ftp://ghost.test/", lastVisitedAt: 100 },
          { url: "http://b.test/", lastVisitedAt: Number.NaN },
          "junk",
        ],
        bad: "junk",
      },
    });
    expect(migrated.byProjectKey["good"]).toEqual([
      { url: "http://a.test/", lastVisitedAt: 100, title: "A" },
    ]);
    expect(migrated.byProjectKey["bad"]).toBeUndefined();
  });

  it("normalizes persisted urls with the same rules as live writes", () => {
    const migrated = migratePersistedBrowserHistoryState({
      byProjectKey: {
        good: [{ url: "a.test/path#section", lastVisitedAt: 100 }],
      },
    });
    expect(migrated.byProjectKey["good"]).toEqual([
      { url: "https://a.test/path#section", lastVisitedAt: 100 },
    ]);
  });

  it("restores MRU ordering, deduplicates normalized urls, and enforces project bounds", () => {
    const byProjectKey = Object.fromEntries(
      Array.from({ length: BROWSER_HISTORY_MAX_PROJECTS + 1 }, (_, index) => [
        `project-${index}`,
        [{ url: `http://project-${index}.test/`, lastVisitedAt: index }],
      ]),
    );
    byProjectKey["project-1"] = [
      { url: "a.test/", lastVisitedAt: 1 },
      { url: "http://newer.test/", lastVisitedAt: 3 },
      { url: "https://a.test/", lastVisitedAt: 2 },
    ];

    const migrated = migratePersistedBrowserHistoryState({ byProjectKey });

    expect(Object.keys(migrated.byProjectKey)).toHaveLength(BROWSER_HISTORY_MAX_PROJECTS);
    expect(migrated.byProjectKey["project-0"]).toBeUndefined();
    expect(migrated.byProjectKey["project-1"]).toEqual([
      { url: "http://newer.test/", lastVisitedAt: 3 },
      { url: "https://a.test/", lastVisitedAt: 2 },
    ]);
  });

  it("rejects a lastVisitedAt outside Date's valid range", () => {
    const migrated = migratePersistedBrowserHistoryState({
      byProjectKey: {
        good: [
          { url: "http://a.test/", lastVisitedAt: 100 },
          { url: "http://b.test/", lastVisitedAt: 1e20 },
        ],
      },
    });
    expect(migrated.byProjectKey["good"]).toEqual([{ url: "http://a.test/", lastVisitedAt: 100 }]);
  });

  it("truncates oversized persisted titles to the contract bound", () => {
    const oversized = "x".repeat(BROWSER_HISTORY_MAX_TITLE_LENGTH + 100);
    const migrated = migratePersistedBrowserHistoryState({
      byProjectKey: {
        good: [{ url: "http://a.test/", lastVisitedAt: 100, title: oversized }],
      },
    });
    expect(migrated.byProjectKey["good"]?.[0]?.title).toHaveLength(
      BROWSER_HISTORY_MAX_TITLE_LENGTH,
    );
    expect(migrated.byProjectKey["good"]?.[0]?.title).toBe(
      oversized.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH),
    );
  });
});

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("useBrowserHistoryStore", () => {
  beforeEach(() => {
    resetBrowserHistoryForTests();
  });

  it("records visits for registered threads under the project key", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "myapp.test/admin#section", 1234);
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]).toEqual([
      { url: "https://myapp.test/admin#section", lastVisitedAt: 1234 },
    ]);
  });

  it("does not persist when a thread is already registered to the same project", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    const persist = spyOnPersistWrites();

    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");

    expect(persist).not.toHaveBeenCalled();
  });

  it("ignores invalid urls whether queued pending or recorded post-registration", () => {
    recordVisitForThread(threadRef, "ftp://a.test/", 1);
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "ftp://a.test/", 2);
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});
  });

  it("sets titles update-only via the thread helper", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    setTitleForThreadUrl(threadRef, "http://a.test/", "Should not create");
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});
    recordVisitForThread(threadRef, "http://a.test/#/settings", 1);
    setTitleForThreadUrl(threadRef, "http://a.test/#/settings", "My App");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]?.title).toBe("My App");
  });

  it("does not persist when the title is already set", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://a.test/", 1);
    setTitleForThreadUrl(threadRef, "http://a.test/", "My App");
    const persist = spyOnPersistWrites();
    const byProjectKey = useBrowserHistoryStore.getState().byProjectKey;

    setTitleForThreadUrl(threadRef, "http://a.test/", "My App");

    expect(useBrowserHistoryStore.getState().byProjectKey).toBe(byProjectKey);
    expect(persist).not.toHaveBeenCalled();
  });

  it("sets a title against a settled url that differs from the stored one only by a trailing slash", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://a.test/community", 1);
    setTitleForThreadUrl(threadRef, "http://a.test/community/", "Community");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]).toMatchObject({
      url: "http://a.test/community",
      title: "Community",
    });

    useBrowserHistoryStore.setState({ byProjectKey: {} });
    recordVisitForThread(threadRef, "http://a.test/community/", 1);
    setTitleForThreadUrl(threadRef, "http://a.test/community", "Community");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]).toMatchObject({
      url: "http://a.test/community/",
      title: "Community",
    });
  });

  it("matches a requested localhost URL to the resolved environment host", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://localhost:5173/app", 1);
    setTitleForThreadUrl(threadRef, "http://192.168.64.2:5173/app", "Local App", "192.168.64.2");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]?.title).toBe("Local App");
  });

  it("deduplicates loopback aliases and the resolved environment host", () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.64.2:3773" });
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://localhost:5173/app", 1);
    recordVisitForThread(threadRef, "http://127.0.0.1:5173/app", 2);
    recordVisitForThread(threadRef, "http://192.168.64.2:5173/app", 3);
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]).toEqual([
      { url: "http://localhost:5173/app", lastVisitedAt: 3 },
    ]);

    useBrowserHistoryStore.setState({ byProjectKey: {} });
    recordVisitForThread(threadRef, "http://192.168.64.2:5173/app", 4);
    recordVisitForThread(threadRef, "http://localhost:5173/app", 5);
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]).toEqual([
      { url: "http://localhost:5173/app", lastVisitedAt: 5 },
    ]);
  });

  it("does not match a genuinely different path via the trailing-slash comparison", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://a.test/community", 1);
    setTitleForThreadUrl(threadRef, "http://a.test/community/foo", "Foo");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]?.title).toBeUndefined();
  });

  it("updates only the most recent entry when several share a trailing-slash comparison key", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://a.test/community/", 1);
    recordVisitForThread(threadRef, "http://a.test/community", 2);
    setTitleForThreadUrl(threadRef, "http://a.test/community/", "Community");
    const entries = useBrowserHistoryStore.getState().byProjectKey["proj-a"];
    expect(entries?.[0]).toMatchObject({ url: "http://a.test/community", title: "Community" });
    expect(entries?.[1]).toMatchObject({ url: "http://a.test/community/" });
    expect(entries?.[1]?.title).toBeUndefined();
  });

  it("truncates oversized titles to the contract bound", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://a.test/", 1);
    const oversized = "y".repeat(BROWSER_HISTORY_MAX_TITLE_LENGTH + 50);
    setTitleForThreadUrl(threadRef, "http://a.test/", oversized);
    const title = useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]?.title;
    expect(title).toHaveLength(BROWSER_HISTORY_MAX_TITLE_LENGTH);
    expect(title).toBe(oversized.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH));
  });

  it("removes entries", () => {
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    recordVisitForThread(threadRef, "http://a.test/", 1);
    recordVisitForThread(threadRef, "http://b.test/", 2);
    removeUrlForThread(threadRef, "http://a.test/");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.map((e) => e.url)).toEqual([
      "http://b.test/",
    ]);
  });
});

describe("pendingVisitsByThreadKey", () => {
  beforeEach(() => {
    resetBrowserHistoryForTests();
  });

  it("queues a visit recorded before registration and drains it in order on registration", () => {
    recordVisitForThread(threadRef, "http://a.test/", 1);
    recordVisitForThread(threadRef, "http://b.test/", 2);
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.map((e) => e.url)).toEqual([
      "http://b.test/",
      "http://a.test/",
    ]);
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]?.lastVisitedAt).toBe(2);
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[1]?.lastVisitedAt).toBe(1);
    expect(useBrowserHistoryStore.getState().pendingVisitsByThreadKey).toEqual({});
  });

  it("caps the per-thread pending list at 10, dropping the oldest", () => {
    for (let i = 0; i < 12; i++) {
      recordVisitForThread(threadRef, `http://a.test/${i}`, i);
    }
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    const urls = useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.map((e) => e.url);
    expect(urls).toHaveLength(10);
    expect(urls).not.toContain("http://a.test/0");
    expect(urls).not.toContain("http://a.test/1");
    expect(urls?.[0]).toBe("http://a.test/11");
  });

  it("slots a replayed visit by timestamp instead of hoisting it above a newer live visit", () => {
    const otherThreadRef = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-2"),
    };
    useBrowserHistoryStore.getState().registerThreadProject(otherThreadRef, "proj-a");
    recordVisitForThread(otherThreadRef, "http://newer.test/", 2000);
    recordVisitForThread(threadRef, "http://older.test/", 1000);
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");

    const entries = useBrowserHistoryStore.getState().byProjectKey["proj-a"];
    expect(entries?.map((e) => e.url)).toEqual(["http://newer.test/", "http://older.test/"]);
    // `entries[0]` being the most recent is the invariant `evictExcessProjects` relies on.
    expect(entries?.[0]?.lastVisitedAt).toBe(2000);
  });
});

describe("pendingTitlesByThreadKey", () => {
  beforeEach(() => {
    resetBrowserHistoryForTests();
  });

  it("buffers a title set before registration and applies it once the matching visit drains", () => {
    recordVisitForThread(threadRef, "http://a.test/", 1);
    setTitleForThreadUrl(threadRef, "http://a.test/", "My App");
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});

    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");

    const entries = useBrowserHistoryStore.getState().byProjectKey["proj-a"];
    expect(entries?.[0]).toMatchObject({ url: "http://a.test/", title: "My App" });
    expect(useBrowserHistoryStore.getState().pendingTitlesByThreadKey).toEqual({});
  });

  it("preserves environment host matching while a title is pending", () => {
    recordVisitForThread(threadRef, "http://localhost:5173/app", 1);
    setTitleForThreadUrl(threadRef, "http://192.168.64.2:5173/app", "Local App", "192.168.64.2");
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, "proj-a");
    expect(useBrowserHistoryStore.getState().byProjectKey["proj-a"]?.[0]?.title).toBe("Local App");
  });
});

describe("mergeBrowserHistoryState", () => {
  it("sanitizes same-version corrupt persisted data and preserves actions", () => {
    // `migrate` only runs when versions differ; `merge` runs on every rehydrate.
    const current = useBrowserHistoryStore.getState();
    const merged = mergeBrowserHistoryState(
      {
        byProjectKey: {
          a: [{ url: "ftp://bad.test/", lastVisitedAt: 1 }],
          b: [{ url: "http://ok.test/", lastVisitedAt: 5 }],
        },
        projectKeyByThreadKey: { good: "b", stale: "a", malformed: 42 },
      },
      current,
    );
    expect(merged.byProjectKey).toEqual({
      b: [{ url: "http://ok.test/", lastVisitedAt: 5 }],
    });
    expect(typeof merged.recordVisit).toBe("function");
    expect(merged.projectKeyByThreadKey).toEqual({ good: "b" });
    expect(merged.pendingVisitsByThreadKey).toEqual({});
    expect(merged.pendingTitlesByThreadKey).toEqual({});
  });
});
