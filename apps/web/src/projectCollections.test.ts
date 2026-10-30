import { EnvironmentId, ProjectId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import type { Project } from "./types";
import {
  collectionMemberMatchesRow,
  editProjectCollectionMembers,
  learnProjectCollectionAliases,
  parseProjectCollections,
  resolveProjectCollectionScope,
  type ProjectCollection,
} from "./projectCollections";

const settings = (mode: SidebarProjectGroupingMode = "repository"): ProjectGroupingSettings => ({
  sidebarProjectGroupingMode: mode,
  sidebarProjectGroupingOverrides: {},
});
const project = (id: string, path: string, overrides: Partial<Project> = {}): Project => ({
  id: ProjectId.make(id),
  environmentId: EnvironmentId.make("local"),
  title: id,
  workspaceRoot: path,
  repositoryIdentity: {
    canonicalKey: "github.com/example/repo",
    rootPath: "/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/repo.git",
    },
  },
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  scripts: [],
  ...overrides,
});
function catalog(projects: Project[], grouping = settings()) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: grouping,
    groupScratchProjects: true,
    primaryEnvironmentId: null,
    resolveEnvironmentLabel: () => null,
  });
}
function capture(
  rows: ReturnType<typeof catalog>,
  keys = rows.map((row) => row.projectKey),
): ProjectCollection {
  return {
    id: "work",
    name: "Work",
    members: editProjectCollectionMembers({
      members: [],
      catalog: rows,
      settings: settings(),
      selectedProjectKeys: new Set(keys),
      removedMemberKeys: new Set(),
    }),
  };
}
function scope(
  collection: ProjectCollection | null,
  rows: ReturnType<typeof catalog>,
  grouping = settings(),
  adHocProjectKeys: string[] = [],
) {
  return resolveProjectCollectionScope({
    collections: collection ? [collection] : [],
    activeCollectionId: collection?.id ?? null,
    catalog: rows,
    settings: grouping,
    adHocProjectKeys,
  });
}

describe("project collections", () => {
  it("keeps overlapping collections independent and distinguishes All, empty, and ad hoc narrowing", () => {
    const rows = catalog([
      project("a", "/a", { repositoryIdentity: null }),
      project("b", "/b", { repositoryIdentity: null }),
    ]);
    const first = capture(rows);
    const second = { ...capture(rows, [rows[0]!.projectKey]), id: "second" };
    expect(scope(first, rows).catalog).toHaveLength(2);
    expect(scope(first, [...rows].reverse()).key).toBe(scope(first, rows).key);
    expect(scope(second, rows).catalog).toHaveLength(1);
    expect(scope(first, rows, settings(), [rows[1]!.projectKey]).groups).toEqual([rows[1]]);
    expect(scope(second, rows, settings(), [rows[1]!.projectKey]).groups).toEqual([rows[0]]);
    expect(scope(null, rows).projectKeys).toBeNull();
    const empty = scope({ ...first, members: [] }, rows);
    expect(empty.projectKeys).toEqual(new Set());
    expect(empty.key).not.toBeNull();
  });

  it("restores selected checkouts after a temporary merge without capturing siblings", () => {
    const projects = [project("root", "/repo"), project("package", "/repo/pkg")];
    const separateRows = catalog(projects, settings("separate"));
    const saved = capture(separateRows, [separateRows[1]!.projectKey]);
    expect(scope(saved, catalog(projects)).catalog).toHaveLength(1);
    const pathRows = catalog(projects, settings("repository_path"));
    expect(
      scope(saved, pathRows, settings("repository_path")).catalog.map((row) => row.id),
    ).toEqual([ProjectId.make("package")]);
    expect(scope(saved, separateRows, settings("separate")).catalog.map((row) => row.id)).toEqual([
      ProjectId.make("package"),
    ]);
    expect(saved.members).toHaveLength(1);
    const overridden = {
      ...settings(),
      sidebarProjectGroupingOverrides: { "local:/repo": "separate" as const },
    };
    expect(
      scope(saved, catalog(projects, overridden), overridden).catalog.map((row) => row.id),
    ).toEqual([ProjectId.make("package")]);
    for (const mode of ["separate", "repository_path"] as const) {
      const mixed = {
        ...settings(),
        sidebarProjectGroupingOverrides: { "local:/repo/pkg": mode },
      };
      const mixedRows = catalog(projects, mixed);
      const members = editProjectCollectionMembers({
        members: [],
        catalog: mixedRows,
        settings: mixed,
        selectedProjectKeys: new Set([mixedRows[1]!.projectKey]),
        removedMemberKeys: new Set(),
      });
      expect(scope({ ...saved, members }, mixedRows, mixed).catalog.map((row) => row.id)).toEqual([
        ProjectId.make("package"),
      ]);
    }
  });

  it("learns delayed identity, survives removing the original environment, and never erases aliases", () => {
    const local = project("local", "/repo", { repositoryIdentity: null });
    const saved = [capture(catalog([local]))];
    const enriched = catalog([project("local", "/repo")]);
    const learned = learnProjectCollectionAliases(saved, enriched);
    expect(learned).not.toBe(saved);
    expect(learnProjectCollectionAliases(learned, enriched)).toBe(learned);
    expect(learnProjectCollectionAliases(learned, catalog([local]))).toBe(learned);
    expect(learnProjectCollectionAliases(learned, [])).toBe(learned);
    const remote = catalog([
      project("remote", "/repo", { environmentId: EnvironmentId.make("remote") }),
    ]);
    expect(scope(learned[0]!, remote).catalog).toHaveLength(1);
    const duplicateRows = catalog([
      project("old", "/repo"),
      project("new", "/repo/", { repositoryIdentity: null, updatedAt: "2026-01-02T00:00:00Z" }),
    ]);
    const duplicateCollection = learnProjectCollectionAliases(
      [capture(duplicateRows)],
      duplicateRows,
    );
    expect(scope(duplicateCollection[0]!, remote).catalog).toHaveLength(1);
    expect(
      scope(
        learned[0]!,
        catalog(
          [project("remote", "/repo", { environmentId: EnvironmentId.make("remote") })],
          settings("separate"),
        ),
        settings("separate"),
      ).catalog,
    ).toHaveLength(0);
  });

  it("removes unchecked alias siblings while preserving unavailable members until explicitly removed", () => {
    const local = project("local", "/repo");
    const offline = project("offline", "/repo", { environmentId: EnvironmentId.make("offline") });
    const missing = project("missing", "/missing", { repositoryIdentity: null });
    const saved = capture(catalog([local, offline, missing]));
    const rows = catalog([local]);
    const next = editProjectCollectionMembers({
      members: saved.members,
      catalog: rows,
      settings: settings(),
      selectedProjectKeys: new Set(),
      removedMemberKeys: new Set(),
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ physicalKey: "local:/missing" });
    expect(
      editProjectCollectionMembers({
        members: next,
        catalog: rows,
        settings: settings(),
        selectedProjectKeys: new Set(),
        removedMemberKeys: new Set(["local:/missing"]),
      }),
    ).toEqual([]);
  });

  it("selects scratch independently of repository aliases and environment copies", () => {
    const rows = catalog([
      project("scratch", "/scratch", { isScratch: true }),
      project("root", "/repo"),
    ]);
    const saved = capture(rows, [rows[0]!.projectKey]);
    const remote = catalog([
      project("remote-scratch", "/other", {
        isScratch: true,
        environmentId: EnvironmentId.make("remote"),
      }),
      project("root", "/repo"),
    ]);
    expect(scope(saved, remote).catalog.map((row) => row.isScratch)).toEqual([true]);
    const beforeConfig = capture(
      catalog([project("scratch", "/scratch", { repositoryIdentity: null })]),
    );
    expect(scope(beforeConfig, rows).catalog).toContain(rows[0]);
    const recognized = learnProjectCollectionAliases([beforeConfig], rows);
    expect(recognized[0]?.members).toEqual([{ kind: "scratch" }]);
    expect(scope(recognized[0]!, remote).catalog.map((row) => row.isScratch)).toEqual([true]);
    expect(saved.members).toEqual([{ kind: "scratch" }]);
    expect(collectionMemberMatchesRow({ kind: "scratch" }, rows[1]!, settings())).toBe(false);
  });

  it("sanitizes malformed persistence without pruning unavailable membership", () => {
    const valid = capture(catalog([project("a", "/a")]));
    const decoded = parseProjectCollections([
      null,
      {},
      { ...valid, name: " All " },
      { ...valid, name: " Work ", members: [...valid.members, null, ...valid.members] },
      { ...valid, id: "duplicate-name", name: "work" },
    ]);
    expect(decoded).toEqual([valid]);
    expect(parseProjectCollections({ collections: [valid] })).toEqual([]);
    expect(
      parseProjectCollections([{ id: "empty", name: "Empty", members: [] }])[0]?.members,
    ).toEqual([]);
  });
});
