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
  if (input.workspaceMode === "worktree" || input.branch.current) {
    return AsyncResult.success(
      input.branch.current ? { ...input.branch, worktreePath: null } : input.branch,
    );
  }

  // Remote refs omit local worktrees, and historical thread metadata can be stale.
  const localName = localBranchName(input.branch);
  let cursor: number | undefined;
  for (;;) {
    const refs = await input.readRefs({
      environmentId: input.project.environmentId,
      input: {
        cwd: input.project.workspaceRoot,
        // Bound the substring query; compare the full name across every page.
        query: localName.slice(0, VCS_REF_QUERY_MAX_LENGTH),
        refKind: "local",
        ...(cursor === undefined ? { refresh: true } : { cursor }),
      },
    });
    if (refs._tag === "Failure") return AsyncResult.failure(refs.cause);
    const local = refs.value.refs.find((ref) => ref.name === localName);
    if (
      local &&
      (!input.branch.isRemote || local.upstreamRef === `refs/remotes/${input.branch.name}`) &&
      (local.current || local.worktreePath)
    ) {
      if (local.current) return AsyncResult.success({ ...local, worktreePath: null });
      if (refs.value.isAtRepositoryRoot === undefined) {
        return AsyncResult.failure(
          Cause.fail(
            new Error(
              "The server did not report whether this project is at the repository root, so this worktree cannot be reused safely. Update the server or choose another branch.",
            ),
          ),
        );
      }
      if (!refs.value.isAtRepositoryRoot) {
        return AsyncResult.failure(
          Cause.fail(
            new Error(
              "This project is a repository subdirectory. Choose another branch or add the repository root as a project to reuse this worktree.",
            ),
          ),
        );
      }
      return AsyncResult.success(local);
    }
    if (local || refs.value.nextCursor === null) break;
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
    worktreePath: null,
  }));
}

// A remote name can itself contain slashes; prefer the authoritative prefix.
function localBranchName(branch: VcsRef): string {
  if (!branch.isRemote) return branch.name;
  const prefix = branch.remoteName ? `${branch.remoteName}/` : null;
  return prefix && branch.name.startsWith(prefix)
    ? branch.name.slice(prefix.length)
    : deriveLocalBranchNameFromRemoteRef(branch.name);
}
