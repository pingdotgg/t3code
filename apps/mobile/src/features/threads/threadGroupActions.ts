import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isListedThreadLineage } from "@t3tools/contracts";

export function planGroupSettle(
  lead: EnvironmentThreadShell,
  workers: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    readonly finishedOnly: boolean;
    readonly isInFlight: (thread: EnvironmentThreadShell) => boolean;
  },
): { readonly targets: ReadonlyArray<EnvironmentThreadShell>; readonly working: number } {
  const unsettled = workers.filter((worker) => worker.settledOverride !== "settled");
  const working = [lead, ...unsettled].filter(options.isInFlight).length;
  const members = options.finishedOnly
    ? unsettled.filter((worker) => !options.isInFlight(worker))
    : unsettled;
  const settlesLead = !(options.finishedOnly && options.isInFlight(lead));
  return { targets: [...(settlesLead ? [lead] : []), ...members], working };
}

export function planGroupSnooze(
  lead: EnvironmentThreadShell,
  workers: ReadonlyArray<EnvironmentThreadShell>,
  options: { readonly now: string },
): {
  readonly targets: ReadonlyArray<EnvironmentThreadShell>;
  readonly skipped: ReadonlyArray<EnvironmentThreadShell>;
} {
  const candidates = workers.filter(
    (worker) => worker.settledOverride !== "settled" && !effectiveSnoozed(worker, options),
  );
  return {
    targets: [lead, ...candidates.filter((worker) => canSnooze(worker, options))],
    skipped: candidates.filter((worker) => !canSnooze(worker, options)),
  };
}

export function resolveAttachTargets(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  thread: EnvironmentThreadShell,
): ReadonlyArray<EnvironmentThreadShell> {
  return [...shells]
    .filter(
      (shell) =>
        shell.environmentId === thread.environmentId &&
        shell.id !== thread.id &&
        shell.archivedAt === null &&
        isListedThreadLineage(shell.lineage) &&
        shell.groupParentThreadId !== thread.id,
    )
    .sort(
      (left, right) =>
        Number(right.projectId === thread.projectId) -
          Number(left.projectId === thread.projectId) ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
}

const threadsOfGroup = (workerCount: number) =>
  `${workerCount} ${workerCount === 1 ? "thread" : "threads"} of this group`;

export function groupLeadArchiveDetail(workerCount: number): string {
  return `${threadsOfGroup(workerCount)} will be shown separately while it is archived.`;
}

export function groupLeadDeleteDetail(workerCount: number): string {
  return `${threadsOfGroup(workerCount)} will stay and become ${workerCount === 1 ? "an ordinary thread" : "ordinary threads"}.`;
}
