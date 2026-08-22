import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";

import {
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  normalizeProjectPathForComparison,
} from "./path.ts";

/**
 * Normalize a workspace path so server-stamped `sourceCwd` values and client
 * thread/project paths compare equal despite trailing separators, doubled
 * separators, `.` / `..` segments, and Windows path form differences.
 *
 * Assumes paths are already absolute in practice (T3 workspace roots are).
 * Relative inputs are still collapsed so comparison stays deterministic;
 * they are not resolved against a process cwd (clients have no server cwd).
 */
export function normalizeProviderSkillWorkspacePath(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (isWindowsAbsolutePath(trimmed) || isUncPath(trimmed) || isWindowsDrivePath(trimmed)) {
    return normalizeWindowsSkillWorkspacePath(trimmed);
  }

  return normalizePosixSkillWorkspacePath(trimmed);
}

function normalizePosixSkillWorkspacePath(value: string): string {
  // Backslash is a legal filename character on POSIX, so it stays part of the
  // segment: `/projects/foo\bar` must not collapse onto `/projects/foo/bar`.
  // Windows forms are routed to the Windows normalizer before we get here.
  const absolute = value.startsWith("/");
  const segments = value.split("/");
  const stack: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }

  if (absolute) {
    return stack.length === 0 ? "/" : `/${stack.join("/")}`;
  }
  return stack.join("/");
}

function normalizeWindowsSkillWorkspacePath(value: string): string {
  // Collapse `.` / `..` with backslash separators, then apply the shared
  // Windows comparison normalizer (case + trailing separators).
  const withBackslash = value.replaceAll("/", "\\");
  const unc = isUncPath(withBackslash);
  const segments = withBackslash.split("\\");
  const stack: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    // Preserve leading empty segments for UNC (`\\server\share`).
    if (segment === "" && unc && stack.length < 2) {
      stack.push(segment);
      continue;
    }
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      // `..` never escapes the root: `\\server\share` (two empties + host +
      // share) and a drive letter are floors, so `C:\..\project` stays
      // `c:\project` and keeps matching the server's resolved path.
      const rootLength = unc ? 4 : /^[A-Za-z]:$/.test(stack[0] ?? "") ? 1 : 0;
      if (stack.length > rootLength) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }

  let collapsed = stack.join("\\");
  if (unc && !collapsed.startsWith("\\\\")) {
    collapsed = `\\\\${collapsed.replace(/^\\+/, "")}`;
  }
  return normalizeProjectPathForComparison(collapsed);
}

export interface FilterProviderSkillsForWorkspaceOptions {
  /**
   * Project `workspaceRoot`. When the chat cwd is a worktree of this project,
   * skills tagged only to the project root are still included so the picker
   * does not go empty while waiting for a re-probe that re-tags under the
   * worktree path. Worktree-tagged skills still win on name collision.
   */
  readonly projectRoot?: string | null;
}

/**
 * Skills in scope for a chat's project/branch (worktree).
 *
 * - User/global skills (`sourceCwd` omitted) are the baseline.
 * - Project skills matching `workspaceCwd` are preferred.
 * - When `projectRoot` is set and differs from `workspaceCwd`, skills tagged
 *   to the project root are also included (worktree fallback).
 * - Project/worktree skills override user skills on name collision.
 * - When `workspaceCwd` is missing, only user/global skills are returned —
 *   never a union of every open workspace.
 */
export function filterProviderSkillsForWorkspace(
  skills: ReadonlyArray<ServerProviderSkill>,
  workspaceCwd: string | null | undefined,
  options?: FilterProviderSkillsForWorkspaceOptions,
): ServerProviderSkill[] {
  return filterWorkspaceScopedByName(skills, workspaceCwd, options);
}

/**
 * Slash commands in scope for a chat's project/branch (worktree).
 *
 * Same scoping rule as `filterProviderSkillsForWorkspace`: harness built-in
 * and user/global commands (`sourceCwd` omitted) are the baseline, project
 * commands matching `workspaceCwd` (or the `projectRoot` fallback) are
 * merged in, and more specific entries win on name collision.
 */
export function filterProviderSlashCommandsForWorkspace(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
  workspaceCwd: string | null | undefined,
  options?: FilterProviderSkillsForWorkspaceOptions,
): ServerProviderSlashCommand[] {
  return filterWorkspaceScopedByName(commands, workspaceCwd, options);
}

function filterWorkspaceScopedByName<
  T extends { readonly name: string; readonly sourceCwd?: string | undefined },
>(
  items: ReadonlyArray<T>,
  workspaceCwd: string | null | undefined,
  options?: FilterProviderSkillsForWorkspaceOptions,
): T[] {
  const normalizedWorkspace =
    workspaceCwd && workspaceCwd.trim().length > 0
      ? normalizeProviderSkillWorkspacePath(workspaceCwd)
      : null;

  const userItems = items.filter((item) => !item.sourceCwd);
  if (normalizedWorkspace === null) {
    return userItems;
  }

  const normalizedProjectRoot =
    options?.projectRoot && options.projectRoot.trim().length > 0
      ? normalizeProviderSkillWorkspacePath(options.projectRoot)
      : null;
  const includeProjectRootFallback =
    normalizedProjectRoot !== null && normalizedProjectRoot !== normalizedWorkspace;

  const worktreeItems: T[] = [];
  const projectRootItems: T[] = [];

  for (const item of items) {
    if (!item.sourceCwd) {
      continue;
    }
    const source = normalizeProviderSkillWorkspacePath(item.sourceCwd);
    if (source === normalizedWorkspace) {
      worktreeItems.push(item);
    } else if (includeProjectRootFallback && source === normalizedProjectRoot) {
      projectRootItems.push(item);
    }
  }

  // User → project-root fallback → exact chat cwd so more specific wins.
  const byName = new Map<string, T>();
  for (const item of userItems) {
    byName.set(item.name, item);
  }
  for (const item of projectRootItems) {
    byName.set(item.name, item);
  }
  for (const item of worktreeItems) {
    byName.set(item.name, item);
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
