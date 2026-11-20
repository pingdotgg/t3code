import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createVcsEnvironmentAtoms } from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { failureText } from "../settings/failureText";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);

/** T3's manual worktree delete. Resolves to the failure text, or null once it is gone. */
export async function deleteWorktree(
  registry: AtomRegistry.AtomRegistry,
  target: { readonly environmentId: EnvironmentId; readonly cwd: string },
  path: string,
): Promise<string | null> {
  const result = await runAtomCommand(
    registry,
    vcsEnvironment.removeWorktree,
    { environmentId: target.environmentId, input: { cwd: target.cwd, path, force: true } },
    { reportFailure: false },
  );
  return result._tag === "Failure" ? failureText(result) : null;
}
