import { listProjectBranches } from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Input } from "../Input.ts";

/** Select an explicit branch or the project's current default branch, never both. */
export type BranchScope =
  | {
      /** Branch resource or explicit branch identity. */
      branch: { projectId: string; branchId: string };
      project?: never;
    }
  | {
      /** Project whose default branch is selected at reconciliation time. */
      project: { projectId: string };
      branch?: never;
    };

export interface ResolvedBranchScope {
  /** Neon project ID. */
  projectId: string;
  /** Neon branch ID. */
  branchId: string;
}

export class InvalidBranchScope extends Data.TaggedError("InvalidBranchScope")<{
  message: string;
}> {}

/** Resolve lifecycle props after Alchemy has resolved resource references. */
export const resolveBranchScope = Effect.fn(function* (
  scope: Input.Resolve<BranchScope>,
) {
  if ((scope.branch !== undefined) === (scope.project !== undefined)) {
    return yield* new InvalidBranchScope({
      message: "Specify exactly one of branch or project",
    });
  }
  if (scope.branch !== undefined) {
    const { projectId, branchId } = scope.branch;
    if (!projectId || !branchId) {
      return yield* new InvalidBranchScope({
        message: "Branch requires projectId and branchId",
      });
    }
    return { projectId, branchId };
  }
  const projectId = scope.project?.projectId;
  if (!projectId) {
    return yield* new InvalidBranchScope({
      message: "Project requires projectId",
    });
  }
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = yield* listProjectBranches({ project_id: projectId, cursor });
    const branch = page.branches.find((branch) => branch.default);
    if (branch) return { projectId, branchId: branch.id };
    cursor = page.pagination?.next;
    if (cursor && seen.has(cursor)) {
      return yield* new InvalidBranchScope({
        message: "Branch pagination repeated a cursor",
      });
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
  return yield* new InvalidBranchScope({
    message: `Project ${projectId} has no default branch`,
  });
});
