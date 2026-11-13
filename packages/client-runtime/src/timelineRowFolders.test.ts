import { expect, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";

import {
  receiptFoldersSignature,
  runFoldersSignature,
  timelineRowFolder,
  timelineRowFolders,
} from "./timelineRowFolders.ts";

it("a row takes its run's folder, then the folder the next move receipt left", () => {
  const legacy = RunId.make("run-legacy");
  const entries = [
    { id: "imported" },
    { id: "legacy", runId: legacy },
    { id: "in-c", runId: RunId.make("run-c") },
    { id: "inherited", runId: RunId.make("run-inherited") },
    { id: "live-wins", runId: RunId.make("run-b") },
    { id: "move-a", previousFolder: "/a" },
    { id: "after-a" },
    { id: "plain" },
    { id: "move-b", previousFolder: "/b" },
    { id: "after-b", runId: legacy },
  ];
  const folders = timelineRowFolders(
    runFoldersSignature(
      [
        { id: RunId.make("run-c"), cwd: "/c", repositoryRoot: "/repo-c" },
        { id: RunId.make("run-b"), cwd: "/worktree" },
        { id: legacy },
      ],
      [
        { id: RunId.make("run-b"), cwd: "/stale" },
        { id: RunId.make("run-inherited"), cwd: "/source" },
      ],
    ),
    receiptFoldersSignature(entries, (entry) => entry.previousFolder),
  );
  const folder = (entry: (typeof entries)[number]) =>
    timelineRowFolder(folders, entry.runId, entry.id);
  expect(folder(entries[2]!)).toEqual({ cwd: "/c", repositoryRoot: "/repo-c" });
  expect(entries.map((entry) => folder(entry)?.cwd)).toEqual([
    "/a",
    "/a",
    "/c",
    "/source",
    "/worktree",
    "/b",
    "/b",
    "/b",
    undefined,
    undefined,
  ]);
});
