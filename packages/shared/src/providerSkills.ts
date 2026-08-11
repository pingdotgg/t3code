import type { ServerProviderSkill } from "@t3tools/contracts";

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
  // Treat backslash as separator so mixed forms from Codex / cross-host paths match.
  const withForward = value.replaceAll("\\", "/");
  const absolute = withForward.startsWith("/");
  const segments = withForward.split("/");
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
      if (stack.length > 0 && stack[stack.length - 1] !== "") {
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
  const normalizedWorkspace =
    workspaceCwd && workspaceCwd.trim().length > 0
      ? normalizeProviderSkillWorkspacePath(workspaceCwd)
      : null;

  const userSkills = skills.filter((skill) => !skill.sourceCwd);
  if (normalizedWorkspace === null) {
    return userSkills;
  }

  const normalizedProjectRoot =
    options?.projectRoot && options.projectRoot.trim().length > 0
      ? normalizeProviderSkillWorkspacePath(options.projectRoot)
      : null;
  const includeProjectRootFallback =
    normalizedProjectRoot !== null && normalizedProjectRoot !== normalizedWorkspace;

  const worktreeSkills: ServerProviderSkill[] = [];
  const projectRootSkills: ServerProviderSkill[] = [];

  for (const skill of skills) {
    if (!skill.sourceCwd) {
      continue;
    }
    const source = normalizeProviderSkillWorkspacePath(skill.sourceCwd);
    if (source === normalizedWorkspace) {
      worktreeSkills.push(skill);
    } else if (includeProjectRootFallback && source === normalizedProjectRoot) {
      projectRootSkills.push(skill);
    }
  }

  // User → project-root fallback → exact chat cwd so more specific wins.
  const byName = new Map<string, ServerProviderSkill>();
  for (const skill of userSkills) {
    byName.set(skill.name, skill);
  }
  for (const skill of projectRootSkills) {
    byName.set(skill.name, skill);
  }
  for (const skill of worktreeSkills) {
    byName.set(skill.name, skill);
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
