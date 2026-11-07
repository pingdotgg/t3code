import {
  type GetProjectBranchesResponse,
  getProjectBranches,
} from "@distilled.cloud/prisma/management";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { PrismaPaginationError } from "./Pagination.ts";
import { isPrismaDevId } from "./Refs.ts";

export class BranchesConflict extends Data.TaggedError("BranchesConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listBranches = (projectId: string, gitName?: string) =>
  Effect.gen(function* () {
    const branches: GetProjectBranchesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getProjectBranches({
        projectId,
        limit: 100,
        ...(gitName === undefined ? {} : { gitName }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      branches.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getProjectBranches: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return branches;
  });

/**
 * Resolve the branch a resource targets: `branchId` as given, `branchGitName`
 * by lookup, or the project's default branch when both are omitted.
 */
export const desiredBranchId = Effect.fn(function* (
  projectId: string,
  props: { branchId?: string; branchGitName?: string },
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return { resolved: true as const, id: props.branchId };
  }
  if (props.branchGitName !== undefined) {
    const branches = yield* listBranches(projectId, props.branchGitName);
    if (branches.length > 1) {
      return yield* new BranchesConflict({
        message: `Prisma returned multiple branches named '${props.branchGitName}' in project '${projectId}'; refusing an ambiguous match.`,
      });
    }
    return branches[0]
      ? { resolved: true as const, id: branches[0].id }
      : { resolved: false as const };
  }
  const branches = yield* listBranches(projectId);
  const defaults = branches.filter((branch) => branch.isDefault);
  if (defaults.length > 1) {
    return yield* new BranchesConflict({
      message: `Prisma returned multiple default branches for project '${projectId}'; refusing an ambiguous match.`,
    });
  }
  const defaultBranch = defaults[0];
  return defaultBranch
    ? { resolved: true as const, id: defaultBranch.id }
    : { resolved: false as const };
});
