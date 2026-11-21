import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createVcsEnvironmentAtoms } from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { failureText } from "../settings/failureText";
import { setupLine } from "./worktreeSetup";

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

const decodeSetupKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, ThreadId]));

/**
 * T3's setup snapshot for a thread, kept for the session after its stream closes or its card
 * remounts, because T3 sends nothing once the agent's run ends. A later snapshot replaces it.
 * Keyed by `[environmentId, threadId]` as JSON.
 */
export const lastSetupSnapshotAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = decodeSetupKey(JSON.parse(key));
  return Atom.make((get): WorktreeSetupSnapshot | null => {
    const live = AsyncResult.getOrElse(
      get(
        vcsEnvironment.worktreeSetup({
          environmentId,
          input: { threadId },
        }),
      ),
      () => null,
    );
    if (live !== null) return live;
    const previous = Option.getOrNull(get.self<WorktreeSetupSnapshot | null>());
    return setupLine(previous)?.kind === "failed" ? previous : null;
  }).pipe(Atom.keepAlive, Atom.withLabel(`worktree-setup-last:${key}`));
});
