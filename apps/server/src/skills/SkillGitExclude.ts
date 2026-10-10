/**
 * SkillGitExclude - keeps the links to library skills out of a project's git status.
 *
 * Those links are the user's own wiring, not part of the project, so they are listed in the
 * repository's `info/exclude` (in the common git dir, so every worktree of the repository shares
 * it) instead of a `.gitignore` that gets committed. T3 Code owns one marked block there and
 * leaves every other line alone; the block goes when its last line does. A project that isn't in a
 * git repository has no exclude file, so its links need nothing. The same repository's other
 * worktrees (`worktreesOf`) hold the links the worktree hook made in them.
 *
 * A file T3 Code creates in a project that isn't meant to be committed, Claude's
 * `.claude/settings.local.json`, is kept out of git the same way (`excludeNewFile`), in a block of
 * its own.
 *
 * @module SkillGitExclude
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import * as VcsProcess from "../vcs/VcsProcess.ts";

export const EXCLUDE_BLOCK_START = "# T3 Code: skills used from Global";
export const EXCLUDE_BLOCK_END = "# End T3 Code: skills used from Global";

/** The lines T3 Code owns in the exclude file are between a start and an end marker. */
export interface ExcludeBlock {
  readonly start: string;
  readonly end: string;
}

const LIBRARY_BLOCK: ExcludeBlock = { start: EXCLUDE_BLOCK_START, end: EXCLUDE_BLOCK_END };
const LOCAL_SETTINGS_BLOCK: ExcludeBlock = {
  start: "# T3 Code: local settings",
  end: "# End T3 Code: local settings",
};

/** A path as one exclude line: anchored at the repository root, with its glob characters quoted. */
const excludeLine = (relative: string) =>
  `/${relative.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length))}`;

/**
 * `text` with the lines in `add` in T3 Code's block and those in `remove` out of it. A block left
 * empty is removed whole. An unfinished block (a start without its end) is left as it is, and so
 * is the text around it: a second block would pair the dangling start with the new end, and T3
 * Code could no longer tell which lines are its own.
 */
export const editExcludeBlock = (
  text: string,
  change: { readonly add: readonly string[]; readonly remove: readonly string[] },
  block: ExcludeBlock = LIBRARY_BLOCK,
) => {
  const lines = text === "" ? [] : text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = lines.indexOf(block.start);
  const end = start < 0 ? -1 : lines.indexOf(block.end, start + 1);
  if (start >= 0 && end < 0) return text;
  const kept = start >= 0 ? lines.slice(start + 1, end) : [];
  const removed = new Set(change.remove);
  const inBlock = [...kept.filter((line) => !removed.has(line)), ...change.add].filter(
    (line, index, all) => all.indexOf(line) === index,
  );
  const marked = inBlock.length === 0 ? [] : [block.start, ...inBlock, block.end];
  const next =
    start >= 0
      ? [...lines.slice(0, start), ...marked, ...lines.slice(end + 1)]
      : [...lines, ...marked];
  return next.length === 0 ? "" : `${next.join("\n")}\n`;
};

/**
 * Adds the links to, or removes them from, the block in the repository's exclude file. `links`
 * are absolute paths inside `projectRoot`. Nothing happens outside a git repository, and a repo
 * whose exclude file can't be written fails.
 */
export const updateExclude = Effect.fn("SkillGitExclude.updateExclude")(function* (input: {
  readonly projectRoot: string;
  readonly links: ReadonlyArray<string>;
  readonly action: "add" | "remove";
  /** The block the lines are kept in; the one for skill links by default. */
  readonly block?: ExcludeBlock;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  if (input.links.length === 0) return;
  const result = yield* vcs
    .run({
      operation: "SkillGitExclude.updateExclude",
      command: "git",
      args: ["rev-parse", "--git-common-dir", "--show-prefix"],
      cwd: input.projectRoot,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  if (result === undefined || result.exitCode !== 0) return;
  const [commonDir = "", prefix = ""] = result.stdout.split("\n");
  if (commonDir === "") return;
  const file = path.join(path.resolve(input.projectRoot, commonDir), "info", "exclude");
  const lines = input.links.map((link) =>
    excludeLine(`${prefix}${path.relative(input.projectRoot, link).replaceAll("\\", "/")}`),
  );
  const text = yield* fileSystem.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
  );
  const next = editExcludeBlock(
    text,
    input.action === "add" ? { add: lines, remove: [] } : { add: [], remove: lines },
    input.block,
  );
  if (next === text || (text === "" && next === "")) return;
  yield* writeFileStringAtomically({ filePath: file, contents: next });
});

/**
 * The checkouts of the repository a project is in, the project's own among them: the paths
 * `git worktree list --porcelain` names. Empty outside a git repository.
 */
export const worktreesOf = Effect.fn("SkillGitExclude.worktreesOf")(function* (
  projectRoot: string,
) {
  const vcs = yield* VcsProcess.VcsProcess;
  const result = yield* vcs
    .run({
      operation: "SkillGitExclude.worktreesOf",
      command: "git",
      args: ["worktree", "list", "--porcelain"],
      cwd: projectRoot,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  if (result === undefined || result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree ") && line.length > "worktree ".length)
    .map((line) => line.slice("worktree ".length));
});

/**
 * The project's folder relative to its repository's root, as `git rev-parse --show-prefix` says:
 * empty when the project is the root, and outside a git repository. A checkout of the repository
 * has the project at that path under its own root.
 */
export const projectPrefixOf = Effect.fn("SkillGitExclude.projectPrefixOf")(function* (
  projectRoot: string,
) {
  const vcs = yield* VcsProcess.VcsProcess;
  const result = yield* vcs
    .run({
      operation: "SkillGitExclude.projectPrefixOf",
      command: "git",
      args: ["rev-parse", "--show-prefix"],
      cwd: projectRoot,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  return result === undefined || result.exitCode !== 0 ? "" : result.stdout.trim();
});

/**
 * Keeps a file T3 Code has just created in a project out of git: Claude Code's own
 * `.claude/settings.local.json`, which is the user's and not the repository's. Claude Code does
 * this itself when it creates the file: "Claude Code keeps it out of git when it creates the file"
 * (https://code.claude.com/docs/en/settings, "Settings files"), by adding it to the global git
 * excludes the first time it writes the file in a repository that doesn't already ignore it. T3
 * Code follows that rule, but in the repository's own `info/exclude`, since it doesn't edit the
 * user's global git configuration. A file the repository already ignores or tracks is left alone,
 * and so is a project that isn't in a git repository.
 */
export const excludeNewFile = Effect.fn("SkillGitExclude.excludeNewFile")(function* (input: {
  readonly projectRoot: string;
  readonly file: string;
}) {
  const vcs = yield* VcsProcess.VcsProcess;
  const asked = (args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "SkillGitExclude.excludeNewFile",
        command: "git",
        args,
        cwd: input.projectRoot,
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
  // `check-ignore` is 0 for an ignored file; `ls-files` is 0 for a tracked one.
  const ignored = yield* asked(["check-ignore", "-q", "--", input.file]);
  const tracked = yield* asked(["ls-files", "--error-unmatch", "--", input.file]);
  if (ignored?.exitCode === 0 || tracked?.exitCode === 0) return;
  yield* updateExclude({
    projectRoot: input.projectRoot,
    links: [input.file],
    action: "add",
    block: LOCAL_SETTINGS_BLOCK,
  });
});
