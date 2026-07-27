// @effect-diagnostics nodeBuiltinImport:off
// These assert facts about files on disk in the checkout itself, which is a
// synchronous filesystem question, not an application concern.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

describe("repo invariants", () => {
  /**
   * `CLAUDE.md` was committed with a trailing newline inside the symlink
   * target — `AGENTS.md\n` — so it never resolved in any checkout or worktree,
   * and the repo's own instructions were silently unreadable under that name.
   * A symlink is one byte away from broken; assert the byte.
   */
  it("CLAUDE.md resolves to AGENTS.md", () => {
    const link = NodePath.join(repoRoot, "CLAUDE.md");
    assert.isTrue(NodeFS.lstatSync(link).isSymbolicLink(), "CLAUDE.md should be a symlink");
    assert.strictEqual(NodeFS.readlinkSync(link), "AGENTS.md");
    assert.isTrue(NodeFS.existsSync(link), "CLAUDE.md should resolve to an existing file");
    assert.match(NodeFS.readFileSync(link, "utf8"), /^# AGENTS\.md/);
  });

  it("the scripts agents are told to run are executable", () => {
    for (const relativePath of [
      "scripts/setup-worktree.sh",
      "apps/mac/scripts/swift-test.sh",
      ".vite-hooks/post-checkout",
    ]) {
      const absolute = NodePath.join(repoRoot, relativePath);
      assert.isTrue(NodeFS.existsSync(absolute), `${relativePath} should exist`);
      const executable = (NodeFS.statSync(absolute).mode & 0o111) !== 0;
      assert.isTrue(executable, `${relativePath} should be executable`);
    }
  });
});
