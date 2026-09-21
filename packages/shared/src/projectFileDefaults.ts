/**
 * Canonical priority order for a preference that a repository can also
 * declare in its checked-in t3.json:
 *
 *   project setting > environment setting > t3.json > built-in default
 *
 * `setting` is the project-over-environment value `resolveProjectSettings`
 * already produces; null means neither scope set anything. The file sits
 * below both because it is the one tier a user cannot change without a
 * commit. Web resolves imperatively at draft creation, mobile reactively,
 * and the server at bootstrap; all must route through this so the surfaces
 * cannot disagree on the order.
 */
export function resolveProjectFileDefault<T>(sources: {
  readonly setting: T | null | undefined;
  readonly projectFile: T | null | undefined;
  readonly builtIn: T;
}): T {
  return sources.setting ?? sources.projectFile ?? sources.builtIn;
}

/**
 * True once the resolved value can no longer change: an explicit pick or a
 * setting that outranks t3.json decided, or the file read settled. While
 * false, nothing may persist the provisional value (for example into a
 * draft's workspace selection) because it could differ from the final one.
 */
export function isProjectFileDefaultSettled<T>(sources: {
  readonly explicit: T | undefined;
  readonly setting: T | null | undefined;
  readonly projectFilePending: boolean;
}): boolean {
  return sources.explicit !== undefined || sources.setting != null || !sources.projectFilePending;
}
