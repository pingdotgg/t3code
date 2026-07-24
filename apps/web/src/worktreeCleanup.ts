import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VcsRemoveWorktreeInput } from "@t3tools/contracts";

import type { ThreadShell } from "./types";

interface ScheduleWorktreeRemovalInput<E> {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly removeWorktree: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: VcsRemoveWorktreeInput;
  }) => Promise<AtomCommandResult<void, E>>;
  readonly onFailure: (
    failure: Extract<AtomCommandResult<void, E>, { readonly _tag: "Failure" }>,
  ) => void;
}

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return normalizeWorktreePath(thread.worktreePath) === targetWorktreePath;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}

export function scheduleWorktreeRemoval<E>(input: ScheduleWorktreeRemovalInput<E>): void {
  void input
    .removeWorktree({
      environmentId: input.environmentId,
      input: {
        cwd: input.cwd,
        path: input.path,
        force: true,
      },
    })
    .then((result) => {
      if (result._tag === "Failure") {
        input.onFailure(result);
      }
    });
}
