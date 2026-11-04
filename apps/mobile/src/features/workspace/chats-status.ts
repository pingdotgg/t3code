import { deadlineStore } from "@t3tools/client-runtime/clock";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { Atom } from "effect/reactivity";

import {
  nextSnoozeWakeAfter,
  resolveThreadListV2Status,
  threadHasUnseenCompletion,
} from "../threads/threadListV2";

const STATUS_PRIORITY = ["approval", "input", "request", "failed", "done"] as const;

export function resolveChatsStatus(threads: ReadonlyArray<EnvironmentThreadShell>, now: string) {
  let priority: number = STATUS_PRIORITY.length;
  for (const thread of threads) {
    const status = resolveThreadListV2Status(thread);
    const candidate = status === "ready" && threadHasUnseenCompletion(thread) ? "done" : status;
    const index = STATUS_PRIORITY.findIndex((entry) => entry === candidate);
    if (
      index === -1 ||
      index >= priority ||
      thread.settledOverride === "settled" ||
      effectiveSnoozed(thread, { now })
    ) {
      continue;
    }
    if (index === 0) return "approval";
    priority = index;
  }
  return STATUS_PRIORITY[priority] ?? null;
}

export function createChatsStatusAtom(
  threadsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>,
) {
  return Atom.make((get) => {
    const threads = get(threadsAtom);
    const now = Date.now();
    get.addFinalizer(
      deadlineStore(nextSnoozeWakeAfter(threads, now)).subscribe(() => get.refreshSelf()),
    );
    return resolveChatsStatus(threads, new Date(now).toISOString());
  });
}
