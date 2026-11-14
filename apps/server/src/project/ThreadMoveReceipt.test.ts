import { assert, it } from "@effect/vitest";

import {
  previousFolderAfter,
  threadMoveReceiptMessage,
  type ThreadMoveReceiptInput,
} from "./ThreadMoveReceipt.ts";

const move = {
  folder: "/repos/b",
  previousFolder: "/repos/a",
  project: "B",
  previousProject: "A",
  members: ["Side chat", "Subagent"],
  clearedBranch: "feat/login",
  pullRequest: { number: 12, url: "https://github.com/o/r/pull/12" },
  leftFolder: null,
};

const receipt = (change: Partial<ThreadMoveReceiptInput> = {}) =>
  threadMoveReceiptMessage({ ...move, ...change }).split("\n");
/** The indexes of the lines that differ between two receipts. */
const changed = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.flatMap((line, index) => (line === right[index] ? [] : [index]));

it("writes the receipt for a move out of a project root, a worktree or a scratch folder", () => {
  const full = receipt();
  // The client shows the first line as the heading, and renders a path in inline code as a link.
  assert.include(full[0], "B");
  assert.include(full[1], '"A"');
  assert.include(full[1], "`/repos/a`");
  assert.include(full[2], "`/repos/b`");
  assert.include(receipt({ folder: "/repos/b`c" })[2], "`` /repos/b`c ``");

  // The moved threads and the cleared branch each add one line, and no other line needs them.
  const optional = full.filter(
    (line) => line.includes('"Side chat", "Subagent"') || line.includes('"feat/login"'),
  );
  assert.lengthOf(optional, 2);
  assert.deepStrictEqual(
    receipt({ members: [], clearedBranch: null, pullRequest: null }),
    full.filter((line) => !optional.includes(line)),
  );
  // The pull request is on the branch line, and only when the thread has one.
  const unlinked = receipt({ pullRequest: null });
  assert.deepStrictEqual(changed(unlinked, full), [full.indexOf(optional[1]!)]);
  assert.include(unlinked.join("\n"), '"feat/login"');
  for (const part of ["#12", "https://github.com/o/r/pull/12"]) {
    assert.include(optional[1], part);
    assert.notInclude(unlinked.join("\n"), part);
  }

  // A worktree or scratch folder adds two lines: if it stays on disk, and who still works in it.
  const worktree = receipt({
    previousFolder: "/worktrees/w",
    leftFolder: { exists: true, project: "P", otherThreads: ["Fork", "Archived"] },
  });
  assert.include(worktree[1], "`/worktrees/w`");
  assert.include(worktree[4], '"P", "Fork", "Archived"');
  // Without those lines, only the line about the folder it came from differs from a root move.
  assert.deepStrictEqual(
    changed(
      worktree.toSpliced(3, 2).map((line) => line.replaceAll("/worktrees/w", "/repos/a")),
      full,
    ),
    [1],
  );
  // A folder that is gone and empty changes those two lines and no other.
  const gone = receipt({
    previousFolder: "/scratch/s",
    leftFolder: { exists: false, project: null, otherThreads: [] },
  });
  assert.deepStrictEqual(
    changed(
      gone,
      worktree.map((line) => line.replaceAll("/worktrees/w", "/scratch/s")),
    ),
    [3, 4],
  );
});

it("resolves a row against the first move receipt after it", () => {
  const items = [
    { type: "user_message" as const, ordinal: 1 },
    { type: "system_notice" as const, ordinal: 2 },
    { type: "system_notice" as const, ordinal: 3, previousFolder: "/a" },
    { type: "user_message" as const, ordinal: 4 },
    { type: "system_notice" as const, ordinal: 5, previousFolder: "/b" },
  ];
  assert.strictEqual(previousFolderAfter(items, 1), "/a");
  assert.strictEqual(previousFolderAfter(items, 3), "/b");
  assert.strictEqual(previousFolderAfter(items, 4), "/b");
  assert.strictEqual(previousFolderAfter(items, 5), undefined);
});
