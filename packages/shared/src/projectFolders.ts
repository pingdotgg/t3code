/**
 * Project source folder helpers.
 *
 * A project owns one primary folder — its `workspaceRoot` — plus zero or more
 * additional folders. This module is the single place that folder ordering and
 * mutation semantics are defined; nothing downstream may re-derive them from
 * `workspaceRoot` and `additionalFolders` directly.
 *
 * Kept free of Effect and of any runtime `@t3tools/contracts` import so the
 * server, the CLI, and every client can share it.
 *
 * @module projectFolders
 */
import type { ProjectSourceFolder } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "./path.ts";

/**
 * The minimal project shape the folder helpers need.
 *
 * Both `OrchestrationProject` and `OrchestrationProjectShell` satisfy it
 * structurally, so callers can pass either without adapting.
 */
export interface ProjectFolderSource {
  readonly workspaceRoot: string;
  readonly additionalFolders: ReadonlyArray<ProjectSourceFolder>;
}

export interface ProjectFolderView {
  readonly path: string;
  readonly label?: string;
  readonly isPrimary: boolean;
}

/**
 * The canonical folder list for a project: primary first, then the additional
 * folders in stored order.
 */
export function projectSourceFolders(
  project: ProjectFolderSource,
): ReadonlyArray<ProjectFolderView> {
  return [
    { path: project.workspaceRoot, isPrimary: true },
    ...project.additionalFolders.map((folder) => ({
      path: folder.path,
      ...(folder.label !== undefined ? { label: folder.label } : {}),
      isPrimary: false as const,
    })),
  ];
}

/**
 * Primary-first path list.
 */
export function projectSourceFolderPaths(project: ProjectFolderSource): ReadonlyArray<string> {
  return projectSourceFolders(project).map((folder) => folder.path);
}

/**
 * Non-primary paths only — what gets forwarded to providers as additional
 * directories.
 */
export function additionalProjectFolderPaths(project: ProjectFolderSource): ReadonlyArray<string> {
  return project.additionalFolders.map((folder) => folder.path);
}

/**
 * Order-insensitive, normalization-aware set equality.
 *
 * Used to decide whether a provider session must restart because its folder set
 * changed. Reordering folders is not a material change; adding or removing one
 * is.
 */
export function sameFolderSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftKeys = new Set(left.map(normalizeProjectPathForComparison));
  if (leftKeys.size !== left.length) {
    // Duplicates on the left: fall back to a multiset comparison.
    const remaining = left.map(normalizeProjectPathForComparison);
    for (const value of right) {
      const index = remaining.indexOf(normalizeProjectPathForComparison(value));
      if (index === -1) {
        return false;
      }
      remaining.splice(index, 1);
    }
    return remaining.length === 0;
  }
  for (const value of right) {
    if (!leftKeys.has(normalizeProjectPathForComparison(value))) {
      return false;
    }
  }
  return true;
}

export type ProjectFolderIntent =
  | { readonly kind: "add"; readonly path: string; readonly label?: string }
  | { readonly kind: "remove"; readonly path: string }
  | { readonly kind: "promote"; readonly path: string };

export interface ProjectFolderMutation {
  /** Present only when the primary folder changes. */
  readonly workspaceRoot?: string;
  readonly additionalFolders: ReadonlyArray<ProjectSourceFolder>;
}

/**
 * Turn an add / remove / promote intent into the field pair for a single
 * `project.meta.update` command.
 *
 * Shared by the CLI and the UI so that promotion is always expressed as the
 * atomic swap of `workspaceRoot` with the promoted entry — never as two
 * commands that could interleave.
 *
 * Returns `null` when the intent is a no-op or names a folder the project does
 * not own.
 */
export function planProjectFolderMutation(
  project: ProjectFolderSource,
  intent: ProjectFolderIntent,
): ProjectFolderMutation | null {
  const key = normalizeProjectPathForComparison(intent.path);
  const primaryKey = normalizeProjectPathForComparison(project.workspaceRoot);
  const index = project.additionalFolders.findIndex(
    (folder) => normalizeProjectPathForComparison(folder.path) === key,
  );

  switch (intent.kind) {
    case "add": {
      if (key === primaryKey || index >= 0) {
        return null;
      }
      return {
        additionalFolders: [
          ...project.additionalFolders,
          {
            path: intent.path,
            ...(intent.label !== undefined ? { label: intent.label } : {}),
          },
        ],
      };
    }
    case "remove": {
      if (index < 0) {
        return null;
      }
      return {
        additionalFolders: project.additionalFolders.filter((_, position) => position !== index),
      };
    }
    case "promote": {
      if (key === primaryKey) {
        return null;
      }
      const promoted = project.additionalFolders[index];
      if (promoted === undefined) {
        return null;
      }
      return {
        workspaceRoot: promoted.path,
        // The outgoing primary takes the promoted folder's slot, so the list
        // keeps its order and the folder set is unchanged.
        additionalFolders: project.additionalFolders.map((folder, position) =>
          position === index ? { path: project.workspaceRoot } : folder,
        ),
      };
    }
  }
}
