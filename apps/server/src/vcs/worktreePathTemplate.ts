import type * as Path from "effect/Path";

interface WorktreePathTemplateInput {
  readonly cwd: string;
  readonly worktreesDir: string;
  readonly template: string;
  readonly branch: string;
}

const WORKTREE_PATH_PLACEHOLDER = /\{(worktreesDir|repoRoot|repoName|branch)\}/g;

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
  const placeholders = {
    worktreesDir: path.resolve(input.worktreesDir),
    repoRoot,
    repoName: path.basename(repoRoot),
    branch,
  } as const;
  const expanded = input.template.replace(
    WORKTREE_PATH_PLACEHOLDER,
    (_placeholder, name: keyof typeof placeholders) => placeholders[name],
  );

  return path.resolve(repoRoot, expanded);
}

export function matchesWorktreePathTemplate(
  path: Path.Path,
  input: Omit<WorktreePathTemplateInput, "branch"> & { readonly candidate: string },
): boolean {
  const branchMarker = "__t3_worktree_branch__";
  const resolvedTemplate = resolveWorktreePathTemplate(path, {
    ...input,
    branch: branchMarker,
  });

  const pattern = resolvedTemplate.split(branchMarker).map(literalPathPattern).join("[^\\\\/]+");

  return new RegExp(`^${pattern}$`).test(path.resolve(input.candidate));
}
