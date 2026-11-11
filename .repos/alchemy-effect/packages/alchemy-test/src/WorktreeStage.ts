import { userStage } from "alchemy/Cli/commands/flags";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The name of the linked git worktree containing `cwd`, or `undefined` in a
 * main checkout (or outside git). A linked worktree's `.git` is a file
 * pointing at `<common>/.git/worktrees/<name>`; a submodule's points at
 * `.git/modules/<name>` and doesn't count.
 */
export const worktreeName = Effect.fn(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = cwd;
  while (true) {
    const dotGit = path.join(dir, ".git");
    if (yield* fs.exists(dotGit)) {
      const info = yield* fs.stat(dotGit);
      if (info.type !== "File") return undefined;
      const gitdir = /^gitdir:\s*(.+)$/m.exec(yield* fs.readFileString(dotGit))?.[1]?.trim();
      const parts = gitdir?.split(/[\\/]+/).filter(Boolean) ?? [];
      return parts.at(-2) === "worktrees" ? parts.at(-1) : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
});

/**
 * The default test stage for a linked worktree: `test_$USER_<worktree>`, so
 * concurrent runs from two worktrees of one developer never share
 * deployments. `undefined` in a main checkout, which keeps `test_$USER`.
 */
export const worktreeStage = Effect.fn(function* (cwd: string) {
  const name = yield* worktreeName(cwd).pipe(Effect.orElseSucceed(() => undefined));
  if (name === undefined) return undefined;
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (safe === "") return undefined;
  return `${yield* userStage("test")}_${safe}`;
});
