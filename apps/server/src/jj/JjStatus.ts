import * as Effect from "effect/Effect";
import type { JjSegmentRow, JjVcsDriverShape } from "../vcs/JjVcsDriver.ts";
import { isT3WorkspaceName, workspaceNameForRef } from "./JjWorkspaces.ts";
/**
 * The bookmark a workspace is working under: the lexicographically first name on the LAST
 * bookmarked row of `heads(::@ & bookmarks())::@`. Both halves keep the value stable across polls,
 * which is what stops `VcsStatusBroadcaster`'s fingerprint from churning on every tick.
 */
export function refNameFromSegment(
  segment: ReadonlyArray<JjSegmentRow>,
  excludedManagedWorkspaces?: ReadonlySet<string>,
): string | null {
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const row = segment[index];
    if (row !== undefined && row.localBookmarks.length > 0) {
      let selected: string | null = null;
      for (const bookmark of row.localBookmarks) {
        if (excludedManagedWorkspaces?.has(workspaceNameForRef(bookmark))) continue;
        if (selected === null || bookmark < selected) selected = bookmark;
      }
      if (selected !== null) return selected;
    }
  }
  return null;
}
export function refNameFromWorkspaceSegment(
  segment: ReadonlyArray<JjSegmentRow>,
  workspaceName: string,
): string | null {
  if (!isT3WorkspaceName(workspaceName)) {
    return refNameFromSegment(segment);
  }
  // A deleted thread bookmark must not redirect writes onto another bookmark such as main.
  for (const row of segment) {
    const bookmark = row.localBookmarks.find((name) => workspaceNameForRef(name) === workspaceName);
    if (bookmark !== undefined) return bookmark;
  }
  return null;
}
export const resolveWorkspaceRefName = Effect.fn("JjStatus.resolveWorkspaceRefName")(function* (
  driver: Pick<JjVcsDriverShape, "repoPaths" | "listWorkspaces">,
  cwd: string,
  segment: ReadonlyArray<JjSegmentRow>,
) {
  const paths = yield* driver.repoPaths(cwd);
  const workspaces = yield* driver.listWorkspaces(cwd);
  const workspace = workspaces.find((entry) => entry.root === paths.workspaceRoot);
  if (workspace === undefined) return null;
  if (isT3WorkspaceName(workspace.name)) {
    return refNameFromWorkspaceSegment(segment, workspace.name);
  }
  // Child bookmarks can share the parent's revision without becoming the parent's current ref.
  const otherManagedWorkspaces = new Set<string>();
  for (const entry of workspaces) {
    if (entry.name !== workspace.name && isT3WorkspaceName(entry.name)) {
      otherManagedWorkspaces.add(entry.name);
    }
  }
  return refNameFromSegment(segment, otherManagedWorkspaces);
});
