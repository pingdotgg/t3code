import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SOURCE_CONTROL_PREFS,
  MAX_PERSISTED_COMMIT_DRAFTS,
  MAX_PERSISTED_PREF_SCOPES,
  migrateSourceControlState,
  sanitizeSourceControlPrefs,
  selectSourceControlPrefs,
} from "./sourceControlStore";

// F-31 — the store was persisted with no version, no migration and no
// validation, so a hand-edited or downgrade-written value rendered a control
// whose DOM state disagreed with the state that produced it (a `<select>` with
// no matching option shows its first option while the store says otherwise).

describe("sanitizeSourceControlPrefs (F-31)", () => {
  it("falls back per field instead of rejecting the whole scope", () => {
    const prefs = sanitizeSourceControlPrefs({
      activeSection: "history",
      viewMode: "tree",
      filter: "bogus",
      historySort: 42,
      stashesOpen: "yes",
      collapsedGroups: ["staged", 7, null],
    });
    // The valid fields survive…
    expect(prefs.activeSection).toBe("history");
    expect(prefs.viewMode).toBe("tree");
    // …and only the invalid ones fall back.
    expect(prefs.filter).toBe(DEFAULT_SOURCE_CONTROL_PREFS.filter);
    expect(prefs.historySort).toBe(DEFAULT_SOURCE_CONTROL_PREFS.historySort);
    expect(prefs.stashesOpen).toBe(DEFAULT_SOURCE_CONTROL_PREFS.stashesOpen);
    expect(prefs.collapsedGroups).toEqual(["staged"]);
  });

  it("never yields an activeSection the panel cannot render", () => {
    expect(sanitizeSourceControlPrefs({ activeSection: "garbage" }).activeSection).toBe("changes");
    expect(sanitizeSourceControlPrefs(null)).toEqual(DEFAULT_SOURCE_CONTROL_PREFS);
    expect(sanitizeSourceControlPrefs("nope")).toEqual(DEFAULT_SOURCE_CONTROL_PREFS);
  });
});

describe("migrateSourceControlState (F-31)", () => {
  it("survives a payload of any shape", () => {
    expect(migrateSourceControlState(undefined)).toEqual({
      prefsByScope: {},
      commitDraftByCwd: {},
    });
    expect(migrateSourceControlState("garbage")).toEqual({
      prefsByScope: {},
      commitDraftByCwd: {},
    });
    expect(migrateSourceControlState({ prefsByScope: 7, commitDraftByCwd: [] })).toEqual({
      prefsByScope: {},
      commitDraftByCwd: {},
    });
  });

  it("drops non-string and empty drafts rather than persisting them", () => {
    const migrated = migrateSourceControlState({
      commitDraftByCwd: { "/a": "keep me", "/b": "", "/c": 12, "/d": null },
    });
    expect(migrated.commitDraftByCwd).toEqual({ "/a": "keep me" });
  });

  it("caps both maps, keeping the newest entries", () => {
    const prefsByScope: Record<string, unknown> = {};
    for (let index = 0; index < MAX_PERSISTED_PREF_SCOPES + 25; index += 1) {
      prefsByScope[`scope-${index}`] = { activeSection: "changes" };
    }
    const commitDraftByCwd: Record<string, string> = {};
    for (let index = 0; index < MAX_PERSISTED_COMMIT_DRAFTS + 25; index += 1) {
      commitDraftByCwd[`/repo-${index}`] = "draft";
    }

    const migrated = migrateSourceControlState({ prefsByScope, commitDraftByCwd });
    expect(Object.keys(migrated.prefsByScope)).toHaveLength(MAX_PERSISTED_PREF_SCOPES);
    expect(Object.keys(migrated.commitDraftByCwd)).toHaveLength(MAX_PERSISTED_COMMIT_DRAFTS);
    // The tail is the newest: zustand rewrites the whole map on every set.
    expect(migrated.prefsByScope[`scope-${MAX_PERSISTED_PREF_SCOPES + 24}`]).toBeDefined();
    expect(migrated.prefsByScope["scope-0"]).toBeUndefined();
  });

  it("validates every surviving scope", () => {
    const migrated = migrateSourceControlState({
      prefsByScope: { a: { filter: "not-a-filter", viewMode: "tree" } },
    });
    expect(migrated.prefsByScope.a?.filter).toBe("all");
    expect(migrated.prefsByScope.a?.viewMode).toBe("tree");
  });
});

describe("selectSourceControlPrefs", () => {
  it("returns the module-level default object (stable identity, no render loop)", () => {
    expect(selectSourceControlPrefs({}, null)).toBe(DEFAULT_SOURCE_CONTROL_PREFS);
    expect(selectSourceControlPrefs({}, "missing")).toBe(DEFAULT_SOURCE_CONTROL_PREFS);
  });
});
