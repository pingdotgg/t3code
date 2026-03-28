export function expandWorkspacePattern(repoRoot: string, pattern: string): Promise<string[]>;

export function collectWorkspacePackages(repoRoot: string): Promise<
  Array<{
    name: string;
    directory: string;
  }>
>;

export function ensureWorkspaceLink(input: {
  rootNodeModulesDir: string;
  name: string;
  directory: string;
}): Promise<void>;

export function syncWorkspaceLinks(repoRoot: string): Promise<void>;
