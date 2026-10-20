// @effect-diagnostics nodeBuiltinImport:off - applies generated patches to a real temporary Git index.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { SelectedLineRange } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  reviewSelectedLinesPatch,
  reviewPatchHunks,
} from "@t3tools/client-runtime/review-workspace";

function withGitFile(
  before: string | null,
  after: string | null,
  test: (git: (args: string[], input?: string) => string, patches: ReadonlyArray<string>) => void,
) {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-line-staging-"));
  const git = (args: string[], input?: string) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  try {
    git(["init", "--quiet"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    if (before !== null) NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), before);
    git(["add", "."]);
    git(["commit", "--quiet", "--allow-empty", "-m", "base"]);
    if (after === null) NodeFS.rmSync(NodePath.join(cwd, "file.txt"));
    else NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), after);
    if (before === null) git(["add", "--intent-to-add", "file.txt"]);
    const diff = git(["diff", "--no-ext-diff", "--", "file.txt"]);
    const patches = reviewPatchHunks(diff).flatMap((file) => file.hunks);
    test(git, patches);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
}

function applyLines(
  git: (args: string[], input?: string) => string,
  patches: ReadonlyArray<string>,
  range: SelectedLineRange,
  staged = false,
) {
  const patch = reviewSelectedLinesPatch(patches, range, staged);
  expect(patch).toBeDefined();
  git(["apply", "--cached", ...(staged ? ["--reverse"] : []), "--", "-"], patch);
}

function indexFile(git: (args: string[]) => string) {
  return git(["show", ":file.txt"]);
}

function stagedPatches(git: (args: string[]) => string) {
  return reviewPatchHunks(git(["diff", "--cached", "--no-ext-diff", "--", "file.txt"])).flatMap(
    (file) => file.hunks,
  );
}

describe("selected line staging through Git's index", () => {
  it("stages just one addition in a replacement, leaving all deletions untouched", () => {
    withGitFile(
      "start\nold one\nold two\nend\n",
      "start\nnew one\nnew two\nend\n",
      (git, patches) => {
        applyLines(git, patches, { start: 3, end: 3, side: "additions" });
        expect(indexFile(git)).toBe("start\nold one\nold two\nnew two\nend\n");
      },
    );
  });

  it("stages just one deletion and can unstage that deletion without removing other changes", () => {
    withGitFile(
      "start\nold one\nold two\nend\n",
      "start\nnew one\nnew two\nend\n",
      (git, patches) => {
        applyLines(git, patches, { start: 2, end: 2, side: "deletions" });
        expect(indexFile(git)).toBe("start\nold two\nend\n");
        applyLines(git, stagedPatches(git), { start: 2, end: 2, side: "deletions" }, true);
        expect(indexFile(git)).toBe("start\nold one\nold two\nend\n");
      },
    );
  });

  it("stages a selection across both sides of a replacement, including reversed selections", () => {
    for (const range of [
      { start: 2, end: 3, side: "deletions", endSide: "additions" },
      { start: 3, end: 2, side: "additions", endSide: "deletions" },
    ] as const) {
      withGitFile(
        "start\nold one\nold two\nend\n",
        "start\nnew one\nnew two\nend\n",
        (git, patches) => {
          applyLines(git, patches, range);
          expect(indexFile(git)).toBe("start\nnew one\nnew two\nend\n");
          applyLines(git, stagedPatches(git), range, true);
          expect(indexFile(git)).toBe("start\nold one\nold two\nend\n");
        },
      );
    }
  });

  it("unstages selected additions from a fully staged replacement and keeps the deletion staged", () => {
    withGitFile("start\nold one\nold two\nend\n", "start\nnew one\nnew two\nend\n", (git) => {
      git(["add", "file.txt"]);
      applyLines(git, stagedPatches(git), { start: 2, end: 2, side: "additions" }, true);
      expect(indexFile(git)).toBe("start\nnew two\nend\n");
    });
  });

  it("matches paired selected rows in split view, including a single replaced row", () => {
    withGitFile(
      "start\nold one\nold two\nend\n",
      "start\nnew one\nnew two\nend\n",
      (git, patches) => {
        const patch = reviewSelectedLinesPatch(
          patches,
          { start: 3, end: 3, side: "additions" },
          false,
          "split",
        );
        expect(patch).toBeDefined();
        git(["apply", "--cached", "--", "-"], patch);
        expect(indexFile(git)).toBe("start\nold one\nnew two\nend\n");
        git(["add", "file.txt"]);
        const reverse = reviewSelectedLinesPatch(
          stagedPatches(git),
          { start: 3, end: 3, side: "additions" },
          true,
          "split",
        );
        expect(reverse).toBeDefined();
        git(["apply", "--cached", "--reverse", "--", "-"], reverse);
        expect(indexFile(git)).toBe("start\nnew one\nold two\nend\n");
      },
    );
  });

  it("includes deletions visibly between same-side endpoints in unified view", () => {
    withGitFile(
      "start\nold one\nkeep\nold two\nend\n",
      "start\nnew one\nkeep\nnew two\nend\n",
      (git, patches) => {
        applyLines(git, patches, { start: 2, end: 4, side: "additions" });
        expect(indexFile(git)).toBe("start\nold one\nnew one\nkeep\nnew two\nend\n");
      },
    );
  });

  it("uses correct offsets when selected additions span multiple hunks and earlier changes are excluded", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const before = lines.join("\n") + "\n";
    lines.splice(2, 0, "addition near top", "excluded addition");
    lines.splice(24, 0, "addition near bottom");
    const after = lines.join("\n") + "\n";
    withGitFile(before, after, (git, patches) => {
      applyLines(git, patches, { start: 4, end: 25, side: "additions" });
      const expected = before
        .replace("line 2\n", "line 2\nexcluded addition\n")
        .replace("line 22\n", "line 22\naddition near bottom\n");
      expect(indexFile(git)).toBe(expected);
      git(["add", "file.txt"]);
      applyLines(git, stagedPatches(git), { start: 4, end: 25, side: "additions" }, true);
      expect(indexFile(git)).toBe(before.replace("line 2\n", "line 2\naddition near top\n"));
    });
  });

  it("uses correct offsets for multiple selected deletions", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");
    const after = before.replace("line 3\n", "").replace("line 4\n", "").replace("line 24\n", "");
    withGitFile(before, after, (git, patches) => {
      applyLines(git, patches, { start: 4, end: 24, side: "deletions" });
      expect(indexFile(git)).toBe(before.replace("line 4\n", "").replace("line 24\n", ""));
      git(["add", "file.txt"]);
      applyLines(git, stagedPatches(git), { start: 4, end: 24, side: "deletions" }, true);
      expect(indexFile(git)).toBe(before.replace("line 3\n", ""));
    });
  });

  it("stages a partial new file and unstages part of a fully staged new file", () => {
    withGitFile(null, "one\ntwo\nthree\n", (git, patches) => {
      applyLines(git, patches, { start: 2, end: 2, side: "additions" });
      expect(indexFile(git)).toBe("two\n");
      git(["add", "file.txt"]);
      applyLines(git, stagedPatches(git), { start: 2, end: 2, side: "additions" }, true);
      expect(indexFile(git)).toBe("one\nthree\n");
    });
  });

  it("stages a partial file deletion and restores part of a fully staged deletion", () => {
    withGitFile("one\ntwo\nthree\n", null, (git, patches) => {
      applyLines(git, patches, { start: 2, end: 2, side: "deletions" });
      expect(indexFile(git)).toBe("one\nthree\n");
      git(["add", "file.txt"]);
      applyLines(git, stagedPatches(git), { start: 2, end: 2, side: "deletions" }, true);
      expect(indexFile(git)).toBe("two\n");
    });
  });

  it("preserves end-of-file newline markers during a partial replacement", () => {
    withGitFile("old", "new", (git, patches) => {
      applyLines(git, patches, { start: 1, end: 1, side: "deletions", endSide: "additions" });
      expect(indexFile(git)).toBe("new");
      applyLines(
        git,
        stagedPatches(git),
        { start: 1, end: 1, side: "deletions", endSide: "additions" },
        true,
      );
      expect(indexFile(git)).toBe("old");
    });
  });

  it("does not produce a staging patch for context or a missing cross-side endpoint", () => {
    withGitFile("start\nold\nend\n", "start\nnew\nend\n", (_git, patches) => {
      expect(
        reviewSelectedLinesPatch(patches, { start: 1, end: 1, side: "additions" }, false),
      ).toBeUndefined();
      expect(
        reviewSelectedLinesPatch(
          patches,
          { start: 900, end: 2, side: "deletions", endSide: "additions" },
          false,
        ),
      ).toBeUndefined();
    });
  });
});
