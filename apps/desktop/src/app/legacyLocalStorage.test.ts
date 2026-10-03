import { describe, expect, it } from "vite-plus/test";
import { importLegacyLocalStorage, LEGACY_LOCAL_STORAGE_IMPORT_KEY } from "./legacyLocalStorage.ts";

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const stashKey = "t3code:prompt-stash:v2";
const draftsKey = "t3code:composer-drafts:v1";
const persisted = (state: unknown, version = 2) => JSON.stringify({ version, state });

describe("V1 Local Storage import", () => {
  it("restores an empty profile, copies only T3 preferences, and leaves V2 choices intact", () => {
    const target = storage({ "t3code:theme": "light" });
    const stash = persisted({ entries: [{ id: "old", prompt: "recover this" }] });
    importLegacyLocalStorage(target, [
      [stashKey, stash],
      ["t3code:theme", "dark"],
      ["other", "secret"],
    ]);
    expect(target.getItem(stashKey)).toBe(stash);
    expect(target.getItem("t3code:theme")).toBe("light");
    expect(target.getItem("other")).toBeNull();
    expect(target.getItem(LEGACY_LOCAL_STORAGE_IMPORT_KEY)).toBe("1");
  });

  it("merges stash IDs without overwriting a V2 edit or truncating recovered text", () => {
    const target = storage({
      [stashKey]: persisted({ entries: [{ id: "same", prompt: "V2 edit" }] }),
    });
    const oldEntries = Array.from({ length: 25 }, (_, index) => ({
      id: `old-${index}`,
      prompt: `text-${index}`,
    }));
    importLegacyLocalStorage(target, [
      [stashKey, persisted({ entries: [{ id: "same", prompt: "V1" }, ...oldEntries] })],
    ]);
    expect(JSON.parse(target.getItem(stashKey)!).state.entries).toEqual([
      { id: "same", prompt: "V2 edit" },
      ...oldEntries,
    ]);
  });

  it("merges draft maps with V2 winning conflicts and keeps V2 sticky choices", () => {
    const target = storage({
      [draftsKey]: persisted(
        { draftsByThreadKey: { same: { prompt: "V2" }, new: {} }, stickyProvider: "new" },
        9,
      ),
    });
    importLegacyLocalStorage(target, [
      [
        draftsKey,
        persisted(
          {
            draftsByThreadKey: { same: { prompt: "V1" }, old: { prompt: "recover" } },
            stickyProvider: "old",
          },
          9,
        ),
      ],
    ]);
    expect(JSON.parse(target.getItem(draftsKey)!).state).toEqual({
      draftsByThreadKey: { same: { prompt: "V2" }, new: {}, old: { prompt: "recover" } },
      stickyProvider: "new",
    });
  });

  it("recovers V1 content over an empty V2 draft while retaining V2 preferences", () => {
    const target = storage({
      [draftsKey]: persisted(
        {
          draftsByThreadKey: {
            old: { prompt: "", attachments: [], activeProvider: "new" },
            image: { prompt: "", attachments: [{ id: "new-image" }] },
          },
        },
        9,
      ),
    });
    importLegacyLocalStorage(target, [
      [
        draftsKey,
        persisted(
          {
            draftsByThreadKey: {
              old: {
                prompt: "recover this",
                attachments: [{ id: "old-image" }],
                activeProvider: "old",
              },
              image: { prompt: "old prompt", attachments: [] },
            },
          },
          9,
        ),
      ],
    ]);
    expect(JSON.parse(target.getItem(draftsKey)!).state.draftsByThreadKey).toEqual({
      old: { prompt: "recover this", attachments: [{ id: "old-image" }], activeProvider: "new" },
      image: { prompt: "", attachments: [{ id: "new-image" }] },
    });
  });

  it("does not mix incompatible draft schemas or overwrite malformed V2 storage", () => {
    const current = persisted({ draftsByThreadKey: { new: {} } }, 9);
    const target = storage({ [draftsKey]: current, [stashKey]: "invalid" });
    importLegacyLocalStorage(target, [
      [draftsKey, persisted({ draftsByThreadId: { old: {} } }, 2)],
      [stashKey, persisted({ entries: [] })],
    ]);
    expect(target.getItem(draftsKey)).toBe(current);
    expect(target.getItem(stashKey)).toBe("invalid");
  });

  it("retries after quota failure without duplicates, then never resurrects deleted entries", () => {
    const target = storage();
    const entries: Array<[string, string]> = [
      [stashKey, persisted({ entries: [{ id: "old", prompt: "recover" }] })],
      ["t3code:theme", "dark"],
    ];
    expect(() =>
      importLegacyLocalStorage(
        {
          ...target,
          setItem: (key, value) => {
            if (key === "t3code:theme") throw new Error("quota");
            target.setItem(key, value);
          },
        },
        entries,
      ),
    ).toThrow("quota");
    expect(target.getItem(LEGACY_LOCAL_STORAGE_IMPORT_KEY)).toBeNull();
    importLegacyLocalStorage(target, entries);
    expect(JSON.parse(target.getItem(stashKey)!).state.entries).toHaveLength(1);
    target.setItem(stashKey, persisted({ entries: [] }));
    importLegacyLocalStorage(target, entries);
    expect(JSON.parse(target.getItem(stashKey)!).state.entries).toEqual([]);
  });
});
