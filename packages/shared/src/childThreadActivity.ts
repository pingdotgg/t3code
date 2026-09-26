/**
 * Child-thread activity (toolboxmd/t3code#31): whether a thread's descendant
 * child threads are working now, derived from thread shells alone.
 *
 * Child threads are hidden from the sidebar, so their work would otherwise
 * never reach the parent. Callers pass their own copy of the `sub.<parent>.<suffix>`
 * id parser so this stays free of any one app's identity rules.
 */
export interface ChildThreadActivityShell {
  readonly id: string;
  readonly archivedAt: string | null;
  readonly session: { readonly status: string; readonly updatedAt: string } | null;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

export interface ChildThreadActivity {
  /** Descendant child threads working now. */
  readonly workingCount: number;
  /** When the earliest working descendant started, for the Working timer. */
  readonly workingSince: string | null;
  /** Any descendant child thread waiting on an approval. */
  readonly hasPendingApprovals: boolean;
  /** Any descendant child thread waiting on the user's answer. */
  readonly hasPendingUserInput: boolean;
}

/**
 * Same "working" as the sidebar's own status: a running or starting session,
 * or a live background fleet after the turn, unless the thread waits on the
 * user or its session failed.
 */
export function isThreadShellWorking(shell: ChildThreadActivityShell): boolean {
  if (shell.archivedAt !== null || shell.hasPendingApprovals || shell.hasPendingUserInput) {
    return false;
  }
  const session = shell.session?.status;
  if (session === "running" || session === "starting") return true;
  return session !== "error" && shell.backgroundLiveness === "working";
}

/** The open turn's start, else the session's last change (the sidebar's own rule). */
function workingStartedAt(shell: ChildThreadActivityShell): string | null {
  const turn = shell.latestTurn;
  const candidates =
    turn !== null && turn.completedAt === null
      ? [turn.startedAt, turn.requestedAt, shell.session?.updatedAt]
      : [shell.session?.updatedAt];
  return (
    candidates.find((candidate) => candidate != null && !Number.isNaN(Date.parse(candidate))) ??
    null
  );
}

/**
 * Activity per ancestor thread id, counting every live descendant (children
 * of children included). A thread has an entry while any descendant works,
 * waits on the user, or has background work (monitoring included), which is
 * what keeps a thread itself from auto-settling.
 */
export function childThreadActivityByParent(
  shells: ReadonlyArray<ChildThreadActivityShell>,
  parentThreadIdOf: (threadId: string) => string | null,
): ReadonlyMap<string, ChildThreadActivity> {
  const byParent = new Map<
    string,
    { -readonly [K in keyof ChildThreadActivity]: ChildThreadActivity[K] }
  >();
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const working = isThreadShellWorking(shell);
    if (
      !working &&
      !shell.hasPendingApprovals &&
      !shell.hasPendingUserInput &&
      shell.backgroundLiveness == null
    ) {
      continue;
    }
    const startedAt = working ? workingStartedAt(shell) : null;
    // Parent ids are prefixes of child ids, so the walk always terminates.
    for (
      let ancestorId = parentThreadIdOf(shell.id);
      ancestorId !== null;
      ancestorId = parentThreadIdOf(ancestorId)
    ) {
      const entry = byParent.get(ancestorId) ?? {
        workingCount: 0,
        workingSince: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      };
      if (working) entry.workingCount += 1;
      if (
        startedAt !== null &&
        (entry.workingSince === null || Date.parse(startedAt) < Date.parse(entry.workingSince))
      ) {
        entry.workingSince = startedAt;
      }
      if (shell.hasPendingApprovals) entry.hasPendingApprovals = true;
      if (shell.hasPendingUserInput) entry.hasPendingUserInput = true;
      byParent.set(ancestorId, entry);
    }
  }
  return byParent;
}
