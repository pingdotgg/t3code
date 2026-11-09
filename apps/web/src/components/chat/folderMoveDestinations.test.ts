import { expect, it } from "vite-plus/test";

import {
  folderMoveFolderRows,
  folderMoveHighlightsFirstRow,
  folderMoveNoMatchText,
  folderMoveProjectRows,
  folderMoveQueryPath,
  folderMoveTabCompletion,
} from "./folderMoveDestinations";

const project = (id: string, workspaceRoot: string, extra: object = {}) => ({
  id,
  title: id,
  workspaceRoot,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});
const projects = [
  project("alpha", "/repos/alpha"),
  project("beta", "/repos/beta"),
  project("gamma", "/repos/gamma"),
  project("old", "/repos/old", { archivedAt: "2026-01-02T00:00:00.000Z" }),
  project("scratch", "/scratch", { isScratch: true }),
];
const threads = [
  { projectId: "beta", updatedAt: "2026-03-01T00:00:00.000Z" },
  { projectId: "gamma", updatedAt: "2026-02-01T00:00:00.000Z" },
  { projectId: "gamma", updatedAt: "2026-04-01T00:00:00.000Z" },
];
const labels = (rows: ReadonlyArray<{ label: string }>) => rows.map((row) => row.label);

it("reads the destination without one pair of quotes", () => {
  expect(folderMoveQueryPath(' "/a b/c" ')).toBe("/a b/c");
  expect(folderMoveQueryPath("'/a b")).toBe("/a b");
  expect(folderMoveQueryPath("~/x")).toBe("~/x");
});

it("lists the other projects by recent thread activity, then No project", () => {
  const rows = folderMoveProjectRows({
    projects,
    threads,
    currentFolder: "/repos/alpha",
    inNoProject: false,
    query: "",
  });
  expect(labels(rows)).toEqual(["gamma", "beta", "No project"]);
  expect(rows[0]).toMatchObject({
    description: "/repos/gamma",
    action: { kind: "move", path: "/repos/gamma" },
  });
  expect(rows.at(-1)?.action).toEqual({ kind: "no-project" });

  // In a worktree of alpha the thread's folder is not alpha's root, so alpha stays.
  const fromWorktree = folderMoveProjectRows({
    projects,
    threads,
    currentFolder: "/worktrees/alpha-1",
    inNoProject: true,
    query: "",
  });
  expect(labels(fromWorktree)).toEqual(["gamma", "beta", "alpha"]);
});

it("filters projects by title and root, with the exact title first", () => {
  const named = [...projects, project("gam", "/repos/other")];
  const rows = folderMoveProjectRows({
    projects: named,
    threads,
    currentFolder: null,
    inNoProject: false,
    query: "gam",
  });
  expect(labels(rows)).toEqual(["gam", "gamma"]);
  expect(
    labels(
      folderMoveProjectRows({
        projects,
        threads,
        currentFolder: null,
        inNoProject: false,
        query: "repos/be",
      }),
    ),
  ).toEqual(["beta"]);
});

it("makes the first row active for a typed project name only", () => {
  expect(folderMoveHighlightsFirstRow({ query: "harn", isBrowsing: false })).toBe(true);
  expect(folderMoveHighlightsFirstRow({ query: "", isBrowsing: false })).toBe(false);
  expect(folderMoveHighlightsFirstRow({ query: ' "', isBrowsing: false })).toBe(false);
  expect(folderMoveHighlightsFirstRow({ query: "./harn", isBrowsing: true })).toBe(false);
});

const entries = [
  { name: "docs", fullPath: "/repos/docs" },
  { name: "beta", fullPath: "/repos/beta" },
  { name: "drafts", fullPath: "/repos/drafts" },
];

it("offers the browsed folder, its parent, project roots first, then folders", () => {
  const rows = folderMoveFolderRows({
    projects,
    currentFolder: "/repos/alpha",
    query: "~/repos/",
    platform: "MacIntel",
    directoryFullPath: "/repos",
    entries,
  });
  expect(labels(rows)).toEqual(["Use this folder", "..", "beta", "docs", "drafts"]);
  expect(rows.map((row) => row.action)).toEqual([
    { kind: "move", path: "/repos" },
    { kind: "open", query: "~/" },
    { kind: "move", path: "/repos/beta" },
    { kind: "open", query: "~/repos/docs/" },
    { kind: "open", query: "~/repos/drafts/" },
  ]);
  expect(rows.map((row) => row.isProject)).toEqual([false, false, true, false, false]);

  // A typed name filters on the server's entries, and the folder itself is not offered.
  const filtered = folderMoveFolderRows({
    projects,
    currentFolder: null,
    query: '"/repos/d',
    platform: "MacIntel",
    directoryFullPath: "/repos",
    entries: entries.filter((entry) => entry.name.startsWith("d")),
  });
  expect(labels(filtered)).toEqual(["..", "docs", "drafts"]);

  // A browsed folder that is a project root moves there at once.
  const atRoot = folderMoveFolderRows({
    projects,
    currentFolder: null,
    query: "/repos/beta/",
    platform: "MacIntel",
    directoryFullPath: "/repos/beta",
    entries: [],
  });
  expect(atRoot[0]).toMatchObject({ label: "beta", isProject: true, action: { kind: "move" } });
});

it("marks the thread's own folder as current, with the project icon on a project root", () => {
  const browse = (currentFolder: string) =>
    folderMoveFolderRows({
      projects,
      currentFolder,
      query: "/repos/",
      platform: "MacIntel",
      directoryFullPath: "/repos",
      entries: [{ name: "alpha", fullPath: "/repos/alpha" }, ...entries],
    });
  // The current project root sorts with the projects, opens instead of moving, and is current.
  const atRoot = browse("/repos/alpha");
  expect(labels(atRoot)).toEqual(["Use this folder", "..", "alpha", "beta", "docs", "drafts"]);
  expect(atRoot[2]).toEqual({
    id: "folder-move:folder:/repos/alpha",
    group: "Folders",
    icon: "project",
    label: "alpha",
    description: "/repos/alpha",
    isProject: true,
    isCurrent: true,
    action: { kind: "open", query: "/repos/alpha/" },
  });
  expect(atRoot.filter((row) => row.isCurrent === true)).toHaveLength(1);

  // A current folder that is no project root keeps the folder icon.
  const inFolder = browse("/repos/docs/");
  expect(labels(inFolder)).toEqual(["Use this folder", "..", "alpha", "beta", "docs", "drafts"]);
  expect(inFolder[4]).toMatchObject({ icon: "folder", isProject: false, isCurrent: true });
  expect(inFolder[2]).toMatchObject({ icon: "project", isProject: true, action: { kind: "move" } });
  expect(inFolder[2]).not.toHaveProperty("isCurrent");
});

it("does not offer to use a folder the server may not read, and keeps the parent row", () => {
  const rows = folderMoveFolderRows({
    projects,
    currentFolder: null,
    query: "/repos/locked/",
    platform: "MacIntel",
    directoryFullPath: "/repos/locked",
    entries: [],
    unreadable: true,
  });
  expect(labels(rows)).toEqual([".."]);
});

it("says when a typed path or project name matches nothing", () => {
  const noMatch = (query: string, shown: typeof entries, rowCount: number) =>
    folderMoveNoMatchText({
      query,
      platform: "MacIntel",
      directoryFullPath: "/repos",
      entries: shown,
      rowCount,
    });
  // The parent row is still listed, and it does not count as a match.
  expect(noMatch("~/repos/zzz", [], 1)).toBe("No folder at /repos/zzz.");
  // The sentence joins with the parent's own separator.
  expect(
    folderMoveNoMatchText({
      query: "C:\\repos\\zzz",
      platform: "Win32",
      directoryFullPath: "C:\\repos",
      entries: [],
      rowCount: 1,
    }),
  ).toBe("No folder at C:\\repos\\zzz.");
  expect(noMatch("~/repos/d", entries, 3)).toBeNull();
  // A folder with no subfolder is not a failed match.
  expect(noMatch("~/repos/", [], 2)).toBeNull();
  expect(noMatch("harn", [], 0)).toBe(
    'No project matches "harn". Type a path to move to a folder.',
  );
  expect(noMatch("no", [], 1)).toBeNull();
  expect(noMatch("", [], 0)).toBeNull();
  // Nothing is said before the server answers.
  expect(
    folderMoveNoMatchText({
      query: "~/repos/zzz",
      platform: "MacIntel",
      directoryFullPath: null,
      entries: [],
      rowCount: 0,
    }),
  ).toBeNull();
});

it("completes Tab to the highlighted folder or to the common prefix", () => {
  const visible = entries.filter((entry) => entry.name.startsWith("d"));
  const complete = (query: string, shown = visible, highlighted = null) =>
    folderMoveTabCompletion({ query, platform: "MacIntel", highlighted, entries: shown });
  expect(complete("/repos/d", [{ name: "docs", fullPath: "/repos/docs" }])).toBe("/repos/docs/");
  expect(complete("/repos/d", [...visible, { name: "dry", fullPath: "/repos/dry" }])).toBeNull();
  expect(
    complete("/repos/d", [
      { name: "draft-a", fullPath: "/repos/draft-a" },
      { name: "draft-b", fullPath: "/repos/draft-b" },
    ]),
  ).toBe("/repos/draft-");
  expect(complete("alp")).toBeNull();
  const [row] = folderMoveProjectRows({
    projects,
    threads,
    currentFolder: null,
    inNoProject: true,
    query: "beta",
  });
  expect(
    folderMoveTabCompletion({
      query: "beta",
      platform: "MacIntel",
      highlighted: row ?? null,
      entries: [],
    }),
  ).toBe("/repos/beta/");
});
