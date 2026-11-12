import type { EnvironmentThreadFolder } from "@t3tools/client-runtime/state/thread-folders";
import { EnvironmentId, ThreadFolderId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadFolder,
  moveThreadsToFolder,
  readThreadFolders,
  requestThreadFolderRename,
} from "../state/threadFolders";

import {
  isThreadFolderMenuId,
  moveToFolderMenuItem,
  runThreadFolderMenuAction,
} from "./threadFolderMenu";

vi.mock("../state/threadFolders", () => ({
  createThreadFolder: vi.fn(),
  moveThreadsToFolder: vi.fn(),
  readThreadFolders: vi.fn(),
  requestThreadFolderRename: vi.fn(),
  readEnvironmentSupportsThreadFolders: vi.fn(),
}));

const environmentId = EnvironmentId.make("env-1");
const folder = (id: string, threadIds: string[]): EnvironmentThreadFolder => ({
  environmentId,
  id: ThreadFolderId.make(id),
  name: id,
  icon: null,
  rule: null,
  autoFile: false,
  ruleSetAt: null,
  threadIds: threadIds.map((threadId) => ThreadId.make(threadId)),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const menu = (threadIds: string[], canOperate = true) =>
  moveToFolderMenuItem({
    environmentId,
    threadIds: threadIds.map((threadId) => ThreadId.make(threadId)),
    canOperate,
    folders: [folder("a", ["t1", "t2"]), folder("b", [])],
  });

describe("moveToFolderMenuItem", () => {
  it("checks a folder only when it holds every target and offers removal", () => {
    const both = menu(["t1", "t2"]).children!;
    expect(both.map((child) => [child.id, child.checked ?? false])).toEqual([
      ["folder:new", false],
      ["folder:id:a", true],
      ["folder:id:b", false],
      ["folder:remove", false],
    ]);
    expect(menu(["t1", "t3"]).children!.find((c) => c.id === "folder:id:a")?.checked).toBe(false);
  });

  it("hides removal when no target is filed and disables everything without permission", () => {
    expect(menu(["t3"]).children!.some((child) => child.id === "folder:remove")).toBe(false);
    const locked = menu(["t1"], false);
    expect([locked, ...locked.children!].every((item) => item.disabled)).toBe(true);
  });
});

describe("isThreadFolderMenuId", () => {
  it("accepts folder ids and rejects others", () => {
    expect(
      ["folder", "folder:new", "folder:id:x", "folder:remove"].every(isThreadFolderMenuId),
    ).toBe(true);
    expect(isThreadFolderMenuId("pin")).toBe(false);
  });
});

it.each(["folder:new", "folder:new-from-selection", "folder:id:b", "folder:remove"])(
  "batches a large selection for %s without creating extra folders",
  async (action) => {
    vi.clearAllMocks();
    const target = folder("b", []);
    vi.mocked(readThreadFolders).mockReturnValue([target]);
    vi.mocked(createThreadFolder).mockResolvedValue(target.id);
    vi.mocked(moveThreadsToFolder).mockResolvedValue({ folders: [target] });
    const threadIds = Array.from({ length: 205 }, (_, index) => ThreadId.make(`thread:${index}`));
    expect(runThreadFolderMenuAction(action, { environmentId, threadIds })).toBe(true);
    const createsFolder = action === "folder:new" || action === "folder:new-from-selection";
    await vi.waitFor(() => {
      expect(moveThreadsToFolder).toHaveBeenCalledTimes(createsFolder ? 2 : 3);
      if (createsFolder) expect(requestThreadFolderRename).toHaveBeenCalledTimes(1);
    });
    const created = vi.mocked(createThreadFolder).mock.calls;
    expect(created).toHaveLength(createsFolder ? 1 : 0);
    const batches = [
      ...created.map(([input]) => input.threadIds),
      ...vi.mocked(moveThreadsToFolder).mock.calls.map(([input]) => input.threadIds),
    ];
    expect(batches.map((ids) => ids.length)).toEqual([100, 100, 5]);
    expect(batches.flat()).toEqual(threadIds);
    for (const [input] of vi.mocked(moveThreadsToFolder).mock.calls) {
      expect(input.folderId).toBe(action === "folder:remove" ? null : target.id);
    }
  },
);
