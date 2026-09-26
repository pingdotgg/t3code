import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  BROWSER_HISTORY_MAX_TITLE_LENGTH,
  fitHistoryToSaveBudget,
  normalizeHistoryUrl,
  recentHistoryEntries,
  recordHistoryVisit,
  removeHistoryUrl,
  restoreTarget,
  sanitizeHistoryEntries,
  setHistoryEntryTitle,
  upsertHistoryEntry,
} from "./historyStore.ts";

const entry = (overrides = {}) => ({
  url: "http://localhost:3000/",
  lastVisitedAt: 1000,
  ...overrides,
});

NodeTest.describe("normalizeHistoryUrl", () => {
  NodeTest.it("normalizes bare loopback hosts to http and keeps path/query", () => {
    NodeAssert.equal(
      normalizeHistoryUrl("localhost:3000/admin?tab=1"),
      "http://localhost:3000/admin?tab=1",
    );
  });

  NodeTest.it("normalizes bare public hosts to https", () => {
    NodeAssert.equal(normalizeHistoryUrl("myapp.test"), "https://myapp.test/");
  });

  NodeTest.it("preserves hash routes and strips credentials", () => {
    NodeAssert.equal(
      normalizeHistoryUrl("http://localhost:3000/app#/route"),
      "http://localhost:3000/app#/route",
    );
    NodeAssert.equal(
      normalizeHistoryUrl("https://user:secret@example.com/"),
      "https://example.com/",
    );
  });

  NodeTest.it("rejects non-http(s), unparseable, and oversized urls", () => {
    NodeAssert.equal(normalizeHistoryUrl("ftp://example.com"), null);
    NodeAssert.equal(normalizeHistoryUrl(""), null);
    NodeAssert.equal(normalizeHistoryUrl(`http://localhost/${"a".repeat(2048)}`), null);
  });
});

NodeTest.describe("upsertHistoryEntry", () => {
  NodeTest.it("prepends new urls", () => {
    const next = upsertHistoryEntry([entry()], "http://localhost:5173/", 2000);
    NodeAssert.deepEqual(
      next.map((e) => e.url),
      ["http://localhost:5173/", "http://localhost:3000/"],
    );
    NodeAssert.deepEqual(next[0], { url: "http://localhost:5173/", lastVisitedAt: 2000 });
  });

  NodeTest.it("moves revisits to front, updates the timestamp, and keeps the title", () => {
    const existing = [
      entry({ url: "http://a.test/", lastVisitedAt: 500, title: "A" }),
      entry({ url: "http://b.test/", lastVisitedAt: 400 }),
    ];
    const next = upsertHistoryEntry(existing, "http://b.test/", 3000);
    NodeAssert.deepEqual(
      next.map((e) => e.url),
      ["http://b.test/", "http://a.test/"],
    );
    NodeAssert.equal(next[0]?.lastVisitedAt, 3000);
    NodeAssert.equal(next[1]?.title, "A");
  });

  NodeTest.it("caps the list at the per-project limit", () => {
    const full = Array.from({ length: BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT }, (_, i) =>
      entry({ url: `http://ext-${i}.test/`, lastVisitedAt: i }),
    );
    const next = upsertHistoryEntry(full, "http://new.test/", 9999);
    NodeAssert.equal(next.length, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
    NodeAssert.equal(next[0]?.url, "http://new.test/");
    NodeAssert.equal(
      next.some((e) => e.url === `http://ext-${BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT - 1}.test/`),
      false,
    );
    NodeAssert.equal(
      next.some((e) => e.url === "http://ext-0.test/"),
      true,
    );
  });

  NodeTest.it("deduplicates loopback aliases through the visit key", () => {
    let entries = recordHistoryVisit([], "http://localhost:5173/app", 1);
    entries = recordHistoryVisit(entries, "http://127.0.0.1:5173/app", 2);
    NodeAssert.deepEqual(entries, [{ url: "http://localhost:5173/app", lastVisitedAt: 2 }]);
  });

  NodeTest.it("with insertOrdered, slots an older entry below a newer one", () => {
    const existing = [entry({ url: "http://newer.test/", lastVisitedAt: 2000 })];
    const next = upsertHistoryEntry(existing, "http://older.test/", 1000, {
      insertOrdered: true,
    });
    NodeAssert.deepEqual(
      next.map((e) => e.url),
      ["http://newer.test/", "http://older.test/"],
    );
  });

  NodeTest.it("with insertOrdered, a replayed older visit keeps the newer timestamp", () => {
    const existing = [entry({ url: "http://a.test/", lastVisitedAt: 2000 })];
    const next = upsertHistoryEntry(existing, "http://a.test/", 1000, { insertOrdered: true });
    NodeAssert.deepEqual(next, [{ url: "http://a.test/", lastVisitedAt: 2000 }]);
  });
});

NodeTest.describe("recordHistoryVisit", () => {
  NodeTest.it("ignores invalid urls", () => {
    NodeAssert.deepEqual(recordHistoryVisit([], "ftp://a.test/", 1), []);
    NodeAssert.deepEqual(recordHistoryVisit([entry()], "", 2), [entry()]);
  });
});

NodeTest.describe("setHistoryEntryTitle", () => {
  NodeTest.it("never creates an entry", () => {
    NodeAssert.deepEqual(setHistoryEntryTitle([], "http://a.test/", "Nope"), []);
  });

  NodeTest.it("updates the entry matched by the trailing-slash-tolerant key", () => {
    const entries = recordHistoryVisit([], "http://a.test/community", 1);
    const next = setHistoryEntryTitle(entries, "http://a.test/community/", "Community");
    NodeAssert.deepEqual(next, [
      { url: "http://a.test/community", lastVisitedAt: 1, title: "Community" },
    ]);
  });

  NodeTest.it("does not match a genuinely different path", () => {
    const entries = recordHistoryVisit([], "http://a.test/community", 1);
    const next = setHistoryEntryTitle(entries, "http://a.test/community/foo", "Foo");
    NodeAssert.equal(next[0]?.title, undefined);
  });

  NodeTest.it("truncates oversized titles to the contract bound", () => {
    const entries = recordHistoryVisit([], "http://a.test/", 1);
    const oversized = "y".repeat(BROWSER_HISTORY_MAX_TITLE_LENGTH + 50);
    const next = setHistoryEntryTitle(entries, "http://a.test/", oversized);
    NodeAssert.equal(next[0]?.title?.length, BROWSER_HISTORY_MAX_TITLE_LENGTH);
  });
});

NodeTest.describe("removeHistoryUrl", () => {
  NodeTest.it("removes by exact normalized url", () => {
    const entries = [
      entry({ url: "http://a.test/", lastVisitedAt: 2 }),
      entry({ url: "http://b.test/", lastVisitedAt: 1 }),
    ];
    NodeAssert.deepEqual(
      removeHistoryUrl(entries, "http://a.test/").map((e) => e.url),
      ["http://b.test/"],
    );
  });
});

NodeTest.describe("sanitizeHistoryEntries (restore migration)", () => {
  NodeTest.it("drops malformed state and invalid entries", () => {
    NodeAssert.deepEqual(sanitizeHistoryEntries(null), []);
    NodeAssert.deepEqual(sanitizeHistoryEntries(42), []);
    NodeAssert.deepEqual(
      sanitizeHistoryEntries([
        { url: "http://a.test/", lastVisitedAt: 100, title: "A" },
        { url: "", lastVisitedAt: 100 },
        { url: "ftp://ghost.test/", lastVisitedAt: 100 },
        { url: "http://b.test/", lastVisitedAt: Number.NaN },
        { url: "http://c.test/", lastVisitedAt: 1e20 },
        "junk",
      ]),
      [{ url: "http://a.test/", lastVisitedAt: 100, title: "A" }],
    );
  });

  NodeTest.it("normalizes persisted urls with the same rules as live writes", () => {
    NodeAssert.deepEqual(
      sanitizeHistoryEntries([{ url: "a.test/path#section", lastVisitedAt: 100 }]),
      [{ url: "https://a.test/path#section", lastVisitedAt: 100 }],
    );
  });

  NodeTest.it("restores MRU ordering, dedupes normalized urls, and enforces the cap", () => {
    const restored = sanitizeHistoryEntries([
      { url: "a.test/", lastVisitedAt: 1 },
      { url: "http://newer.test/", lastVisitedAt: 3 },
      { url: "https://a.test/", lastVisitedAt: 2 },
    ]);
    NodeAssert.deepEqual(restored, [
      { url: "http://newer.test/", lastVisitedAt: 3 },
      { url: "https://a.test/", lastVisitedAt: 2 },
    ]);

    const oversized = Array.from(
      { length: BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT + 10 },
      (_, i) => ({ url: `http://cap-${i}.test/`, lastVisitedAt: i }),
    );
    NodeAssert.equal(
      sanitizeHistoryEntries(oversized).length,
      BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
    );
  });

  NodeTest.it("truncates oversized persisted titles", () => {
    const oversized = "x".repeat(BROWSER_HISTORY_MAX_TITLE_LENGTH + 100);
    const restored = sanitizeHistoryEntries([
      { url: "http://a.test/", lastVisitedAt: 100, title: oversized },
    ]);
    NodeAssert.equal(restored[0]?.title, oversized.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH));
  });
});

NodeTest.describe("recentHistoryEntries", () => {
  NodeTest.it("returns the display slice of the MRU list", () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({ url: `http://r-${i}.test/`, lastVisitedAt: 100 - i }),
    );
    const recents = recentHistoryEntries(entries);
    NodeAssert.equal(recents.length, 8);
    NodeAssert.equal(recents[0]?.url, "http://r-0.test/");
  });
});

NodeTest.describe("restoreTarget", () => {
  const LEASE_URL = "http://localhost:3773/api/assets/token123/site/index.html";

  NodeTest.it("a presented file always wins the record's location", () => {
    NodeAssert.deepEqual(restoreTarget("site/index.html", "https://a.test/"), {
      relativePath: "site/index.html",
    });
    NodeAssert.deepEqual(restoreTarget("site/index.html", LEASE_URL), {
      relativePath: "site/index.html",
    });
    NodeAssert.deepEqual(restoreTarget("site/index.html", null), {
      relativePath: "site/index.html",
    });
  });

  NodeTest.it("persists an ordinary requested url", () => {
    NodeAssert.deepEqual(restoreTarget(null, "https://a.test/"), { url: "https://a.test/" });
  });

  NodeTest.it("a lease url — or no target — writes no location, never a stale path", () => {
    // With fileSource cleared (pasted lease
    // url), falling back to the mount-time restored.relativePath would write
    // back a path this session did not navigate to.
    NodeAssert.deepEqual(restoreTarget(null, LEASE_URL), {});
    NodeAssert.deepEqual(restoreTarget(null, null), {});
  });
});

NodeTest.describe("fitHistoryToSaveBudget", () => {
  NodeTest.it("drops the oldest entries until the record fits the envelope", () => {
    const entries = Array.from({ length: BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT }, (_, i) =>
      entry({ url: `http://fit.test/${"a".repeat(2000)}${i}`, lastVisitedAt: i }),
    );
    const fitted = fitHistoryToSaveBudget({ url: "http://fit.test/" }, entries, 20_000);
    NodeAssert.ok(fitted.length < entries.length);
    NodeAssert.ok(JSON.stringify({ url: "http://fit.test/", history: fitted }).length <= 20_000);
    NodeAssert.equal(fitted[0]?.url, entries[0]?.url, "keeps the most recent entries");
  });

  NodeTest.it("budgets UTF-8 bytes, not UTF-16 chars (the SDK envelope measures bytes)", () => {
    // Reviewer repro: 512 × "界" titles are 512 chars but 1,536 bytes each —
    // a char-counted budget keeps ~39 entries that encode to ~66 KB and make
    // session.save throw. The byte budget must trim until the encoded
    // record actually fits.
    const encoder = new TextEncoder();
    const entries = Array.from({ length: BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT }, (_, i) =>
      entry({
        url: `http://uni-${i}.test/`,
        lastVisitedAt: i,
        title: "界".repeat(BROWSER_HISTORY_MAX_TITLE_LENGTH),
      }),
    );
    const fitted = fitHistoryToSaveBudget({ url: "http://uni.test/" }, entries);
    NodeAssert.ok(fitted.length < entries.length);
    NodeAssert.ok(
      encoder.encode(JSON.stringify({ url: "http://uni.test/", history: fitted })).length <= 56_000,
      "encoded record fits the byte budget",
    );
    NodeAssert.ok(
      encoder.encode(JSON.stringify({ url: "http://uni.test/", history: entries })).length > 65_536,
      "the untrimmed list really did exceed the SDK envelope",
    );
    NodeAssert.equal(fitted[0]?.url, entries[0]?.url, "keeps the most recent entries");
  });

  NodeTest.it("leaves a fitting list untouched", () => {
    const entries = [entry(), entry({ url: "http://b.test/", lastVisitedAt: 900 })];
    NodeAssert.deepEqual(fitHistoryToSaveBudget({}, entries), entries);
  });
});
