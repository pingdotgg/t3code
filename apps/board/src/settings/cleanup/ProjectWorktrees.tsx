import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useContext, useState } from "react";

import { failureText } from "../failureText";
import { SettingsRow } from "../SettingsRow";
import { projectWorktreesAtom } from "../../state/projects";
import { vcsEnvironment } from "../../state/vcs";

export function ProjectWorktrees({
  project,
  titled,
  removedPaths,
}: {
  project: EnvironmentProject;
  titled: boolean;
  /** Worktrees a cleanup run removed, which the repository's list may not show gone yet. */
  removedPaths: ReadonlySet<string>;
}) {
  const registry = useContext(RegistryContext);
  const known = useAtomValue(projectWorktreesAtom).get(project.id) ?? [];
  // The thread list keeps a worktree after its folder is removed, so the repository says which
  // exist. `refresh` skips the engine's snapshot, which a worktree made by a thread does not update.
  const refs = AsyncResult.getOrElse(
    useAtomValue(
      vcsEnvironment.listRefs({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, refKind: "local", limit: 200, refresh: true },
      }),
    ),
    () => null,
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const remove = async (path: string) => {
    setFailure(null);
    const result = await runAtomCommand(
      registry,
      vcsEnvironment.removeWorktree,
      {
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, path, force: true },
      },
      { reportFailure: false },
    );
    setConfirming(null);
    if (result._tag === "Failure") setFailure(failureText(result));
  };

  const onDisk = new Set(
    refs?.refs.flatMap((ref) => (ref.worktreePath === null ? [] : [ref.worktreePath])),
  );
  const worktrees = known.filter(
    (worktree) => onDisk.has(worktree.path) && !removedPaths.has(worktree.path),
  );
  return (
    <>
      {titled && <p className="px-3 pt-2 text-xs font-medium text-muted">{project.title}</p>}
      {refs === null && <p className="px-3 py-2.5 text-xs text-faint">Loading worktrees…</p>}
      {refs !== null && worktrees.length === 0 && (
        <p className="px-3 py-2.5 text-xs text-faint">No worktrees in use.</p>
      )}
      {worktrees.map((worktree) => (
        <SettingsRow
          key={worktree.path}
          title={worktree.path.split("/").findLast(Boolean) ?? worktree.path}
          description={
            <span className="break-all">
              {worktree.path}
              {worktree.branch !== null && ` · ${worktree.branch}`} · {worktree.title}
            </span>
          }
          control={
            confirming === worktree.path ? undefined : (
              <button
                type="button"
                aria-label={`Delete worktree ${worktree.path}`}
                onClick={() => setConfirming(worktree.path)}
                className="rounded-md border border-line px-2.5 py-1 text-fg hover:bg-hover"
              >
                Delete
              </button>
            )
          }
        >
          {confirming === worktree.path && (
            <div
              role="alertdialog"
              aria-label="Delete the worktree?"
              className="flex flex-col gap-2 rounded-md border border-red-400/40 p-2.5"
            >
              <p>Delete the worktree? Its branch stays, and uncommitted changes in it are lost.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void remove(worktree.path)}
                  className="rounded-md bg-red-500 px-2.5 py-1 font-medium text-white hover:bg-red-400"
                >
                  Delete worktree
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="rounded-md border border-line px-2.5 py-1 text-fg hover:bg-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </SettingsRow>
      ))}
      {failure !== null && (
        <p role="alert" className="px-3 py-2 break-words text-red-400">
          {failure}
        </p>
      )}
    </>
  );
}
