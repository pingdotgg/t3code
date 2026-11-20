import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isListedThreadLineage } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

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

export function groupLeadArchiveDetail(workerCount: number, resolve: MessageResolver = m): string {
  return resolve(
    msg(
      "{count, plural, one {{count} thread of this group will be shown separately while it is archived.} other {{count} threads of this group will be shown separately while it is archived.}}",
      { count: workerCount },
    ),
  );
}

export function groupLeadDeleteDetail(workerCount: number, resolve: MessageResolver = m): string {
  return resolve(
    msg(
      "{count, plural, one {{count} thread of this group will stay and become an ordinary thread.} other {{count} threads of this group will stay and become ordinary threads.}}",
      { count: workerCount },
    ),
  );
}
