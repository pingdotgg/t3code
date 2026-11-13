import { assert, it } from "@effect/vitest";

import { previousFolderAfter, threadMoveReceiptMessage } from "./ThreadMoveReceipt.ts";

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

it("writes the receipt for a move out of a project root, a worktree or a scratch folder", () => {
  const full = threadMoveReceiptMessage(move).split("\n");
  assert.deepStrictEqual(full, [
    "Moved to B.",
    'It came from project "A", which has its root at `/repos/a`.',
    "The next turn runs in `/repos/b`.",
    'Moved with it: "Side chat", "Subagent".',
    'Cleared the branch "feat/login". Its pull request #12 (https://github.com/o/r/pull/12) stays linked.',
    "Open terminals keep their folder.",
  ]);
  const minimal = { ...move, members: [], clearedBranch: null, pullRequest: null };
  assert.deepStrictEqual(threadMoveReceiptMessage(minimal).split("\n"), [
    full[0],
    full[1],
    full[2],
    full[5],
  ]);
  assert.include(
    threadMoveReceiptMessage({ ...move, folder: "/repos/b`c" }),
    "\nThe next turn runs in `` /repos/b`c ``.\n",
  );
  assert.include(
    threadMoveReceiptMessage({ ...move, pullRequest: null }),
    '\nCleared the branch "feat/login".\n',
  );
  assert.include(
    threadMoveReceiptMessage({
      ...move,
      previousFolder: "/worktrees/w",
      leftFolder: { exists: true, project: "P", otherThreads: ["Fork", "Archived"] },
    }),
    [
      'It came from project "A", where it worked in `/worktrees/w`.',
      "The next turn runs in `/repos/b`.",
      "The folder `/worktrees/w` stays on disk with all its files until you remove it.",
      'Still working in it: project "P", "Fork", "Archived".',
      'Moved with it: "Side chat", "Subagent".',
    ].join("\n"),
  );
  assert.include(
    threadMoveReceiptMessage({
      ...move,
      previousFolder: "/scratch/s",
      leftFolder: { exists: false, project: null, otherThreads: [] },
    }),
    "\nThe folder no longer exists.\nNo other thread works in it.\n",
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
