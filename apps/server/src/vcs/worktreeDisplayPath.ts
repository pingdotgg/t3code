import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const NUMBERED_WORKTREE_PATH_PATTERN = /^(?:(.+)\/)?([^/]+)\.worktrees\/(\d+)$/;
const ALIASED_WORKTREE_SEGMENT_PATTERN = /^([^/\\[\]]+) \[(?:[^[\]]* )?#(\d+)\]$/;
const GITDIR_PREFIX = "gitdir:";
const HEAD_BRANCH_PREFIX = "ref: refs/heads/";

export function isNumberedWorktreePath(relativePath: string): boolean {
  return NUMBERED_WORKTREE_PATH_PATTERN.test(relativePath);
}

function sanitizeBranchLabel(branchName: string | null | undefined): string {
  if (branchName === null || branchName === undefined) return "";
  return branchName
    .trim()
    .replace(/[/\\[\]\r\n\t]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatWorktreeDisplayPrefix(
  relativePath: string,
  branchName: string | null | undefined,
): string {
  const match = NUMBERED_WORKTREE_PATH_PATTERN.exec(relativePath);
  if (!match) return relativePath;
  const parent = match[1];
  const repo = match[2]!;
  const slot = match[3]!;
  const branch = sanitizeBranchLabel(branchName);
  const segment = branch.length > 0 ? `${repo} [${branch} #${slot}]` : `${repo} [#${slot}]`;
  return parent === undefined || parent.length === 0 ? segment : `${parent}/${segment}`;
}

export function unaliasWorktreeDisplayPath(inputPath: string): string {
  if (!inputPath.includes("[") || !inputPath.includes("#")) return inputPath;
  const tokens = inputPath.split(/([/\\])/);
  const separator = inputPath.includes("\\") && !inputPath.includes("/") ? "\\" : "/";
  let changed = false;
  for (let index = 0; index < tokens.length; index += 2) {
    const segment = tokens[index]!;
    const match = ALIASED_WORKTREE_SEGMENT_PATTERN.exec(segment);
    if (!match) continue;
    tokens[index] = `${match[1]!}.worktrees${separator}${match[2]!}`;
    changed = true;
  }
  return changed ? tokens.join("") : inputPath;
}

export function extractAliasedWorktreePrefix(
  inputPath: string,
  realNestedPath: string,
): string | undefined {
  if (!inputPath.includes("[") || !inputPath.includes("#")) return undefined;
  const segments = inputPath.split("/");
  const rawParts: string[] = [];
  const realParts: string[] = [];
  let aliased = false;
  for (const segment of segments) {
    rawParts.push(segment);
    const match = ALIASED_WORKTREE_SEGMENT_PATTERN.exec(segment);
    if (match) {
      realParts.push(`${match[1]!}.worktrees`, match[2]!);
      aliased = true;
    } else {
      realParts.push(segment);
    }
    const candidate = realParts.join("/");
    if (candidate === realNestedPath) {
      return aliased ? rawParts.join("/") : undefined;
    }
  }
  return undefined;
}

export const readWorktreeBranchName = Effect.fn("worktreeDisplayPath.readWorktreeBranchName")(
  function* (worktreeCwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotGitPath = path.join(worktreeCwd, ".git");
    const dotGitStat = yield* fileSystem.stat(dotGitPath).pipe(Effect.orElseSucceed(() => null));
    if (dotGitStat === null) return null;

    let gitDir = dotGitPath;
    if (dotGitStat.type === "File") {
      const dotGitContents = yield* fileSystem
        .readFileString(dotGitPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (dotGitContents === null) return null;
      const firstLine = dotGitContents.split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (!firstLine.startsWith(GITDIR_PREFIX)) return null;
      const target = firstLine.slice(GITDIR_PREFIX.length).trim();
      if (target.length === 0) return null;
      gitDir = path.resolve(worktreeCwd, target);
    }

    const headContents = yield* fileSystem
      .readFileString(path.join(gitDir, "HEAD"))
      .pipe(Effect.orElseSucceed(() => null));
    if (headContents === null) return null;
    const headLine = headContents.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!headLine.startsWith(HEAD_BRANCH_PREFIX)) return null;
    const branchName = headLine.slice(HEAD_BRANCH_PREFIX.length).trim();
    return branchName.length > 0 ? branchName : null;
  },
);
