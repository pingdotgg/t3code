import { existsSync, statSync } from "node:fs";
import path from "node:path";

export type RepoKind = "git" | "jj";

function hasRepositoryMarker(cwd: string, marker: ".git" | ".jj"): boolean {
  let current = path.resolve(cwd);

  while (true) {
    const candidate = path.join(current, marker);
    if (existsSync(candidate)) {
      if (marker === ".git") {
        return true;
      }

      try {
        return statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

export function detectRepoKind(cwd: string): RepoKind | null {
  if (hasRepositoryMarker(cwd, ".jj")) {
    return "jj";
  }
  if (hasRepositoryMarker(cwd, ".git")) {
    return "git";
  }
  return null;
}

export function isGitRepository(cwd: string): boolean {
  return detectRepoKind(cwd) === "git";
}

export function isJjRepository(cwd: string): boolean {
  return detectRepoKind(cwd) === "jj";
}

export function isVersionControlledRepository(cwd: string): boolean {
  return detectRepoKind(cwd) !== null;
}
