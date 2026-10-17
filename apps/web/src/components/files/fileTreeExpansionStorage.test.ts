import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { setLocalStorageItem } from "~/hooks/useLocalStorage";

import {
  fileTreeExpansionStorageKey,
  readExpandedPaths,
  syncPersistedExpansion,
  writeExpandedPaths,
} from "./fileTreeExpansionStorage";

/** Rows exist only for listed directories, like the real tree. */
function makeTree(rows: Record<string, boolean>) {
  const item = (path: string) => ({
    isDirectory: () => true,
    isExpanded: () => rows[path] ?? false,
    expand: () => {
      rows[path] = true;
    },
    collapse: () => {
      rows[path] = false;
    },
  });
  return {
    rows,
    model: { getItem: (path: string) => (path in rows ? item(path) : null) },
  };
}

function sync(args: {
  tree: ReturnType<typeof makeTree>;
  loaded: string[];
  persisted: string[];
  pending?: string[];
}) {
  const persisted = new Set(args.persisted);
  const pendingRestore = new Set(args.pending ?? args.persisted);
  const changed = syncPersistedExpansion({
    model: args.tree.model,
    directoryPaths: Object.keys(args.tree.rows),
    loadedDirectories: new Set(args.loaded),
    persisted,
    pendingRestore,
  });
  return { changed, persisted, pendingRestore };
}

describe("file tree expansion storage", () => {
  const key = fileTreeExpansionStorageKey(EnvironmentId.make("env-1"), "/work/app");

  it("round-trips the expanded set and treats missing or malformed storage as empty", () => {
    expect(readExpandedPaths(key).size).toBe(0);
    writeExpandedPaths(key, new Set(["apps", "apps/web"]));
    expect([...readExpandedPaths(key)]).toEqual(["apps", "apps/web"]);
    writeExpandedPaths(key, new Set());
    expect(readExpandedPaths(key).size).toBe(0);
    setLocalStorageItem(key, 5, Schema.Number);
    expect(readExpandedPaths(key).size).toBe(0);
  });

  it("keeps the shallowest folders when the set is larger than the bound", () => {
    const deep = Array.from({ length: 600 }, (_, index) => `a/b/c/${index}`);
    writeExpandedPaths(key, new Set([...deep, "a", "a/b"]));
    const stored = readExpandedPaths(key);
    expect(stored.size).toBe(500);
    expect(stored.has("a")).toBe(true);
    expect(stored.has("a/b")).toBe(true);
  });
});

describe("syncPersistedExpansion", () => {
  it("restores a remembered folder once its row appears and keeps the rest pending", () => {
    // `apps/web` is listed only after `apps` is expanded.
    const tree = makeTree({ "apps/": false, "docs/": false });
    const first = sync({ tree, loaded: [""], persisted: ["apps", "apps/web"] });
    expect(tree.rows["apps/"]).toBe(true);
    expect([...first.pendingRestore]).toEqual(["apps/web"]);
    expect([...first.persisted]).toEqual(["apps", "apps/web"]);

    tree.rows["apps/web/"] = false;
    const second = sync({
      tree,
      loaded: ["", "apps"],
      persisted: [...first.persisted],
      pending: [...first.pendingRestore],
    });
    expect(tree.rows["apps/web/"]).toBe(true);
    expect(second.pendingRestore.size).toBe(0);
    expect(second.changed).toBe(false);
  });

  it("does not forget remembered folders before they have been listed", () => {
    const tree = makeTree({ "apps/": false });
    const result = sync({ tree, loaded: [""], persisted: ["apps", "apps/web"] });
    expect(result.persisted.has("apps/web")).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("forgets folders their parent no longer lists, and ones the user collapses", () => {
    const tree = makeTree({ "apps/": true, "docs/": false });
    const result = sync({
      tree,
      loaded: ["", "apps"],
      persisted: ["apps", "docs", "apps/gone"],
      pending: [],
    });
    expect([...result.persisted]).toEqual(["apps"]);
    expect(result.changed).toBe(true);
  });

  it("remembers folders the user expands", () => {
    const tree = makeTree({ "apps/": true });
    const result = sync({ tree, loaded: [""], persisted: [], pending: [] });
    expect([...result.persisted]).toEqual(["apps"]);
    expect(result.changed).toBe(true);
  });
});
