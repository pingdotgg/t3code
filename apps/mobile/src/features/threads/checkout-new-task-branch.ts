import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { VcsSwitchRefInput, VcsSwitchRefResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { shouldCheckoutNewTaskBranch } from "./new-task-context-presentation";

/** Resolve a composer branch only after its checkout succeeds. Existing worktrees
 * and new-worktree base selections already identify a separate workspace. */
export async function checkoutNewTaskBranch<E>(input: {
  readonly branch: VcsRef;
  readonly project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot"> | null;
  readonly workspaceMode: "local" | "worktree";
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
