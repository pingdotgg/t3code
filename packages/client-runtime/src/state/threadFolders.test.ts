import { EnvironmentId, ThreadFolderId, ThreadId, type ThreadFolderRule } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createThreadFolderMemberKeysAtom,
  type EnvironmentThreadFolder,
  layoutThreadFolders,
  readThreadFolderMembers,
  resolveFolderReorder,
  threadFolderCollect,
  type ThreadFolderCollectChoice,
  threadFolderCollectChoices,
  threadFolderCollectUpdate,
} from "./threadFolders.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const thread = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  id: ThreadId.make(id),
});
const folder = (
  environmentId: EnvironmentId,
  id: string,
  threadIds: ReadonlyArray<string>,
): EnvironmentThreadFolder => ({
  environmentId,
  id: ThreadFolderId.make(id),
  name: id,
  icon: null,
  rule: null,
  autoFile: false,
  ruleSetAt: null,
  threadIds: threadIds.map((id) => ThreadId.make(id)),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("layoutThreadFolders", () => {
  it("keeps thread order inside folders, keeps empty folders, and scopes membership by environment", () => {
    const threads = [
      thread(local, "b"),
      thread(remote, "a"),
      thread(local, "a"),
      thread(local, "c"),
    ];
    const layout = layoutThreadFolders({
      threads,
      folders: [folder(local, "reviews", ["a", "b", "missing"]), folder(local, "empty", [])],
    });
    expect(layout.blocks.map((block) => [block.key, block.threads.map((t) => t.id)])).toEqual([
      ["local:reviews", ["b", "a"]],
      ["local:empty", []],
    ]);
    expect(layout.unfiled.map((t) => `${t.environmentId}:${t.id}`)).toEqual([
      "remote:a",
      "local:c",
    ]);
  });
});

describe("resolveFolderReorder", () => {
  it.each([
    [0, { beforeFolderId: "a" }],
    [1, null],
    [2, null],
    [3, { beforeFolderId: "d" }],
    [4, { beforeFolderId: null }],
  ])("drops b at slot %i", (index, expected) => {
    expect(resolveFolderReorder(["a", "b", "c", "d"], ["a", "b", "c", "d"], "b", index)).toEqual(
      expected,
    );
  });

  it("orders within the section the folder shows in", () => {
    const order = ["settled", "b", "c", "late"];
    expect(resolveFolderReorder(order, ["b", "c"], "b", 2)).toEqual({ beforeFolderId: "late" });
    expect(resolveFolderReorder(order, ["c", "b"], "b", 0)).toEqual({ beforeFolderId: "c" });
  });
});

describe("threadFolderCollect", () => {
  const base = folder(local, "f", []);
  const off = { topic: false, branches: [], worktrees: [], custom: false };
  it.each([
    [null, true, off],
    [{ smart: true }, false, off],
    [{ smart: true }, true, { ...off, topic: true }],
    [{ branches: ["a", "b"] }, true, { ...off, branches: ["a", "b"] }],
    [
      { smart: true, branches: ["a"], worktrees: ["t3-1"] },
      true,
      { topic: true, branches: ["a"], worktrees: ["t3-1"], custom: false },
    ],
    [{ smart: true, titleKeywords: ["x"] }, true, { ...off, custom: true }],
  ] as const)("%j autoFile=%s", (rule, autoFile, expected) => {
    expect(threadFolderCollect({ ...base, rule, autoFile })).toEqual(expected);
  });

  it("toggles one option at a time and turns off when none is left", () => {
    const update = (
      rule: ThreadFolderRule | null,
      autoFile: boolean,
      choice: ThreadFolderCollectChoice,
    ) => threadFolderCollectUpdate({ ...base, rule, autoFile }, choice);
    expect(update({ smart: true }, true, { by: "branch", value: "main" })).toEqual({
      type: "folder.update",
      folderId: base.id,
      rule: { smart: true, branches: ["main"] },
      autoFile: true,
    });
    expect(update({ smart: true, branches: ["main"] }, true, { by: "topic" })).toMatchObject({
      rule: { branches: ["main"] },
    });
    expect(update({ branches: ["main"] }, true, { by: "branch", value: "main" })).toEqual({
      type: "folder.update",
      folderId: base.id,
      rule: null,
      autoFile: false,
    });
    expect(update({ branches: ["main"] }, false, { by: "worktree", value: "t3-1" })).toMatchObject({
      rule: { worktrees: ["t3-1"] },
      autoFile: true,
    });
    expect(update({ titleKeywords: ["x"] }, true, { by: "topic" })).toMatchObject({
      rule: { smart: true },
    });
    expect(update({ smart: true }, true, { by: "off" })).toMatchObject({ autoFile: false });
    expect(update(null, false, { by: "off" })).toBeNull();
  });
});

describe("threadFolderCollectChoices", () => {
  const shell = (id: string, branch: string | null, worktreePath: string | null, at: string) => ({
    ...thread(local, id),
    branch,
    worktreePath,
    updatedAt: at,
    archivedAt: null,
  });
  it("lists the folder's own branches first, then recent ones, keeping the current value", () => {
    const choices = threadFolderCollectChoices(
      { ...folder(local, "f", ["member"]), rule: { branches: ["old/*"] }, autoFile: true },
      [
        shell("recent", "feat/b", "/w/t3-2/", "2026-01-03"),
        shell("member", "feat/a", "/w/t3-1", "2026-01-01"),
        shell("dupe", "feat/b", null, "2026-01-02"),
        { ...shell("remote", "remote", null, "2026-01-09"), environmentId: remote },
      ],
    );
    expect(choices).toEqual({
      branches: ["old/*", "feat/a", "feat/b"],
      worktrees: ["t3-1", "t3-2"],
    });
  });
});

describe("readThreadFolderMembers", () => {
  it("loads missing members once per family and excludes other folders and environments", async () => {
    const loaded = thread(local, "loaded");
    const old = thread(local, "old");
    const sibling = thread(local, "sibling");
    const reads: ThreadId[] = [];
    const result = await readThreadFolderMembers(
      folder(local, "f", ["loaded", "old", "sibling", "archived"]),
      [loaded, thread(remote, "old")],
      async (id) => {
        reads.push(id);
        return id === old.id ? [old, sibling, thread(local, "unfiled"), thread(remote, "old")] : [];
      },
    );
    expect(result).toEqual([loaded, old, sibling]);
    expect(reads).toEqual([old.id, ThreadId.make("archived")]);
    await expect(
      readThreadFolderMembers(folder(local, "f", ["missing"]), [], async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
});

it("retains only folder members omitted from each environment's shell", () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const folders = Atom.make([folder(local, "a", ["live", "old"]), folder(remote, "b", ["live"])]);
  const localSnapshot = Atom.make({ threads: [{ id: ThreadId.make("live") }] });
  const remoteSnapshot = Atom.make({ threads: [] as ReadonlyArray<{ readonly id: ThreadId }> });
  const keys = createThreadFolderMemberKeysAtom(folders, (environmentId) =>
    environmentId === local ? localSnapshot : remoteSnapshot,
  );
  const read = () => JSON.parse(registry.get(keys));
  expect(read()).toEqual([
    { environmentId: local, threadId: "old" },
    { environmentId: remote, threadId: "live" },
  ]);
  registry.set(localSnapshot, {
    threads: [{ id: ThreadId.make("live") }, { id: ThreadId.make("old") }],
  });
  expect(read()).toEqual([{ environmentId: remote, threadId: "live" }]);
  registry.set(folders, []);
  expect(read()).toEqual([]);
});
