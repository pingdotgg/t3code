import type * as Path from "effect/Path";

interface WorktreePathTemplateInput {
  readonly cwd: string;
  readonly worktreesDir: string;
  readonly template: string;
  readonly branch: string;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const literalPathPattern = (value: string) =>
  value
    .split(/[\\/]+/)
    .map(escapeRegex)
    .join("[\\\\/]+");

export function resolveWorktreePathTemplate(
  path: Path.Path,
  input: WorktreePathTemplateInput,
): string {
  const repoRoot = path.resolve(input.cwd);
  const branch = input.branch.replace(/\//g, "-");
  const expanded = input.template
    .replaceAll("{worktreesDir}", path.resolve(input.worktreesDir))
    .replaceAll("{repoRoot}", repoRoot)
    .replaceAll("{repoName}", path.basename(repoRoot))
    .replaceAll("{branch}", branch);

  return path.resolve(repoRoot, expanded);
}

export function matchesWorktreePathTemplate(
  path: Path.Path,
  input: WorktreePathTemplateInput & { readonly candidate: string },
): boolean {
  const repoRootMarker = path.resolve(
    path.sep,
    "__t3_worktree_repo_parent__",
    "__t3_worktree_repo_name__",
  );
  const branchMarker = "__t3_worktree_branch__";
  const resolvedTemplate = resolveWorktreePathTemplate(path, {
    ...input,
    cwd: repoRootMarker,
    branch: branchMarker,
  })
    .replaceAll(repoRootMarker, "{repoRoot}")
    .replaceAll("__t3_worktree_repo_name__", "{repoName}")
    .replaceAll(branchMarker, "{branch}");

  const pattern = resolvedTemplate
    .split(/(\{repoRoot\}|\{repoName\}|\{branch\})/)
    .map((part) => {
      if (part === "{repoRoot}") return ".+?";
      if (part === "{repoName}" || part === "{branch}") return "[^\\\\/]+";
      return literalPathPattern(part);
    })
    .join("");

  return new RegExp(`^${pattern}$`).test(path.resolve(input.candidate));
}
