import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  VcsListRefsInput,
  VcsListRefsResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import { deriveLocalBranchNameFromRemoteRef } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { shouldCheckoutNewTaskBranch } from "./new-task-context-presentation";

const VCS_REF_QUERY_MAX_LENGTH = 256;

export async function checkoutNewTaskBranch<E>(input: {
  readonly branch: VcsRef;
  readonly project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot"> | null;
  readonly workspaceMode: "local" | "worktree";
  readonly readRefs: (request: {
    readonly environmentId: EnvironmentProject["environmentId"];
    readonly input: VcsListRefsInput;
  }) => Promise<AtomCommandResult<VcsListRefsResult, E>>;
  readonly switchRef: (request: {
    readonly environmentId: EnvironmentProject["environmentId"];
    readonly input: VcsSwitchRefInput;
  }) => Promise<AtomCommandResult<VcsSwitchRefResult, E>>;
}): Promise<AtomCommandResult<VcsRef, E | Error>> {
  if (!input.project) {
    return AsyncResult.failure(
      Cause.fail(new Error("The selected project is unavailable. Reconnect and try again.")),
    );
  }
  if (
    !shouldCheckoutNewTaskBranch({
      branchIsCurrent: input.branch.current,
      branchWorktreePath: input.branch.worktreePath,
      workspaceMode: input.workspaceMode,
    })
  ) {
    return AsyncResult.success(input.branch);
  }

  // A thread's remembered location and the cached picker list can both be out
  // of date, and a remote ref never carries its local branch's worktree. Git
  // refuses to check out a branch another worktree holds, so reuse that one.
  const localName = localBranchName(input.branch);
  // The query is a substring match, so the exact branch can sit past the
  // first page in a repository with many similarly named branches.
  let cursor: number | undefined;
  for (;;) {
    const refs = await input.readRefs({
      environmentId: input.project.environmentId,
      input: {
        cwd: input.project.workspaceRoot,
        // The contract caps queries; a prefix still matches, and the exact
        // name is compared below.
        query: localName.slice(0, VCS_REF_QUERY_MAX_LENGTH),
        refKind: "local",
        ...(cursor === undefined ? { refresh: true } : { cursor }),
      },
    });
    if (refs._tag === "Failure") return AsyncResult.failure(refs.cause);
    const local = refs.value.refs.find((ref) => ref.name === localName);
    if (local) {
      if (local.current || local.worktreePath) return AsyncResult.success(local);
      break;
    }
    if (refs.value.nextCursor === null) break;
    cursor = refs.value.nextCursor;
  }

  const result = await input.switchRef({
    environmentId: input.project.environmentId,
    input: { cwd: input.project.workspaceRoot, refName: input.branch.name },
  });
  return mapAtomCommandResult(result, (value) => ({
    ...input.branch,
    current: true,
    isRemote: false,
    name: value.refName ?? input.branch.name,
  }));
}

// Remote names may contain slashes, so the ref's own remote name is the only
// reliable prefix; the first-slash split is for refs that do not carry one.
function localBranchName(branch: VcsRef): string {
  if (!branch.isRemote) return branch.name;
  const prefix = branch.remoteName ? `${branch.remoteName}/` : null;
  return prefix && branch.name.startsWith(prefix)
    ? branch.name.slice(prefix.length)
    : deriveLocalBranchNameFromRemoteRef(branch.name);
}
