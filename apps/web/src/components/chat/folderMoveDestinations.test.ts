import { expect, it } from "vite-plus/test";

import {
  type FolderMoveRow,
  folderMoveCannotRead,
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
const entries = [
  { name: "docs", fullPath: "/repos/docs" },
  { name: "beta", fullPath: "/repos/beta" },
  { name: "drafts", fullPath: "/repos/drafts" },
];
const labels = (rows: ReadonlyArray<{ label: string }>) => rows.map((row) => row.label);

/** The project rows for an empty query from no known folder, with `input` on top. */
const projectRows = (input: Partial<Parameters<typeof folderMoveProjectRows>[0]>) =>
  folderMoveProjectRows({
    projects,
    threads,
    currentFolder: null,
    inNoProject: false,
    query: "",
    ...input,
  });

/** The folder rows for `/repos/` and its entries from no known folder, with `input` on top. */
const folderRows = (input: Partial<Parameters<typeof folderMoveFolderRows>[0]>) =>
  folderMoveFolderRows({
    projects,
    currentFolder: null,
    query: "/repos/",
    platform: "MacIntel",
    directoryFullPath: "/repos",
    entries,
    ...input,
  });

it("reads the destination without one pair of quotes", () => {
  expect(folderMoveQueryPath(' "/a b/c" ')).toBe("/a b/c");
  expect(folderMoveQueryPath("'/a b")).toBe("/a b");
  expect(folderMoveQueryPath("~/x")).toBe("~/x");
});

it("lists the other projects by recent thread activity, then No project", () => {
  const rows = projectRows({ currentFolder: "/repos/alpha" });
  expect(labels(rows)).toEqual(["gamma", "beta", "No project"]);
  expect(rows[0]).toMatchObject({
    description: "/repos/gamma",
    action: { kind: "move", path: "/repos/gamma" },
  });
  expect(rows.at(-1)?.action).toEqual({ kind: "no-project" });

  // In a worktree of alpha the thread's folder is not alpha's root, so alpha stays.
  const fromWorktree = projectRows({ currentFolder: "/worktrees/alpha-1", inNoProject: true });
  expect(labels(fromWorktree)).toEqual(["gamma", "beta", "alpha"]);
});

it("filters projects by title and root, with the exact title first", () => {
  const named = [...projects, project("gam", "/repos/other")];
  expect(labels(projectRows({ projects: named, query: "gam" }))).toEqual(["gam", "gamma"]);
  expect(labels(projectRows({ query: "repos/be" }))).toEqual(["beta"]);
});

it("makes the first row active for a typed project name only", () => {
  expect(folderMoveHighlightsFirstRow({ query: "harn", isBrowsing: false })).toBe(true);
  expect(folderMoveHighlightsFirstRow({ query: "", isBrowsing: false })).toBe(false);
  expect(folderMoveHighlightsFirstRow({ query: ' "', isBrowsing: false })).toBe(false);
  expect(folderMoveHighlightsFirstRow({ query: "./harn", isBrowsing: true })).toBe(false);
});

it("offers the browsed folder, its parent, project roots first, then folders", () => {
  const rows = folderRows({ currentFolder: "/repos/alpha", query: "~/repos/" });
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
  const filtered = folderRows({
    query: '"/repos/d',
    entries: entries.filter((entry) => entry.name.startsWith("d")),
  });
  expect(labels(filtered)).toEqual(["..", "docs", "drafts"]);

  // A browsed folder that is a project root moves there at once.
  const atRoot = folderRows({
    query: "/repos/beta/",
    directoryFullPath: "/repos/beta",
    entries: [],
  });
  expect(atRoot[0]).toMatchObject({ label: "beta", isProject: true, action: { kind: "move" } });
});

it("marks the thread's own folder as current, with the project icon on a project root", () => {
  const browse = (currentFolder: string) =>
    folderRows({
      currentFolder,
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
  const locked = (folder: string) =>
    folderRows({ query: `${folder}/`, directoryFullPath: folder, entries: [], unreadable: true });
  expect(labels(locked("/repos/locked"))).toEqual([".."]);
  // The server refuses a project root it may not read like any other folder.
  expect(labels(locked("/repos/beta"))).toEqual([".."]);
});

it("stops waiting for a listing once the session may not read files", () => {
  const cannotRead = (access: { canReadFiles: boolean; isPending: boolean; error: null }) =>
    folderMoveCannotRead({ unreadable: false, listingError: null, access });
  expect(cannotRead({ canReadFiles: true, isPending: false, error: null })).toBe(false);
  expect(cannotRead({ canReadFiles: false, isPending: true, error: null })).toBe(false);
  // A session without the file read permission settles with no error, and no listing follows.
  expect(cannotRead({ canReadFiles: false, isPending: false, error: null })).toBe(true);
});

it("says when a typed path or project name matches nothing", () => {
  const noMatch = (
    query: string,
    shown: typeof entries,
    rowCount: number,
    input: Partial<Parameters<typeof folderMoveNoMatchText>[0]> = {},
  ) =>
    folderMoveNoMatchText({
      query,
      platform: "MacIntel",
      directoryFullPath: "/repos",
      entries: shown,
      rowCount,
      ...input,
    });
  // The parent row is still listed, and it does not count as a match.
  expect(noMatch("~/repos/zzz", [], 1)).toBe("No folder at /repos/zzz.");
  // The sentence joins with the parent's own separator.
  const windows = { platform: "Win32", directoryFullPath: "C:\\repos" };
  expect(noMatch("C:\\repos\\zzz", [], 1, windows)).toBe("No folder at C:\\repos\\zzz.");
  expect(noMatch("~/repos/d", entries, 3)).toBeNull();
  // A folder with no subfolder is not a failed match.
  expect(noMatch("~/repos/", [], 2)).toBeNull();
  expect(noMatch("harn", [], 0)).toBe(
    'No project matches "harn". Type a path to move to a folder.',
  );
  expect(noMatch("no", [], 1)).toBeNull();
  expect(noMatch("", [], 0)).toBeNull();
  // Nothing is said before the server answers.
  expect(noMatch("~/repos/zzz", [], 0, { directoryFullPath: null })).toBeNull();
});

it("completes Tab to the highlighted folder or to the common prefix", () => {
  const visible = entries.filter((entry) => entry.name.startsWith("d"));
  const complete = (query: string, shown = visible, highlighted: FolderMoveRow | null = null) =>
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
  const [row] = projectRows({ inNoProject: true, query: "beta" });
  expect(complete("beta", [], row ?? null)).toBe("/repos/beta/");
});
