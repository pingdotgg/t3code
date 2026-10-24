import {
  CODEX_MICRO_SLOT_COUNT,
  type CodexMicroAgentMode,
  type CodexMicroSlotStatus,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import type { SidebarThreadSummary } from "../types";

export interface CodexMicroSlot {
  readonly index: number;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly title: string | null;
  readonly status: CodexMicroSlotStatus;
}

export const EMPTY_CODEX_MICRO_SLOTS: ReadonlyArray<CodexMicroSlot> = Array.from(
  { length: CODEX_MICRO_SLOT_COUNT },
  (_, index) => ({ index, environmentId: null, threadId: null, title: null, status: "off" }),
);

/** The same states the sidebar shows, folded into the device's five colors. */
export function codexMicroSlotStatus(thread: SidebarThreadSummary): CodexMicroSlotStatus {
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
    case "input":
      return "needs-input";
    case "working":
      return "working";
    case "waiting":
      return thread.blockedOnThreadWait === true ? "working" : "idle";
    case "failed":
    case "limited":
      return "error";
    case "ready":
      return hasUnseenCompletion(thread) ? "done" : "idle";
  }
}

const PRIORITY: Record<CodexMicroSlotStatus, number> = {
  "needs-input": 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 4,
  off: 5,
};

function isVisible(thread: SidebarThreadSummary, now: string): boolean {
  if (thread.deletedAt || thread.archivedAt) return false;
  return !thread.snoozedUntil || thread.snoozedUntil <= now;
}

function rank(
  threads: ReadonlyArray<SidebarThreadSummary>,
  mode: CodexMicroAgentMode,
  now: string,
): SidebarThreadSummary[] {
  const visible = threads.filter((thread) => isVisible(thread, now));
  switch (mode) {
    case "pinned":
      // Sidebar "Pinned" order.
      return visible
        .filter((thread) => thread.pinnedAt)
        .toSorted(
          (a, b) =>
            (a.pinOrderKey ?? "").localeCompare(b.pinOrderKey ?? "") ||
            (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""),
        );
    case "recent":
      return visible.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    case "priority":
      return (
        visible
          .map((thread) => ({ thread, status: codexMicroSlotStatus(thread) }))
          // Live work always shows; finished or idle threads only while in the inbox.
          .filter(
            ({ thread, status }) =>
              status === "working" ||
              status === "needs-input" ||
              thread.pinnedAt !== null ||
              thread.settledAt === null,
          )
          .toSorted(
            (a, b) =>
              PRIORITY[a.status] - PRIORITY[b.status] ||
              Number(b.thread.pinnedAt !== null) - Number(a.thread.pinnedAt !== null) ||
              b.thread.updatedAt.localeCompare(a.thread.updatedAt),
          )
          .map(({ thread }) => thread)
      );
  }
}

/**
 * Picks the threads for the six agent keys. A thread keeps its key while it
 * stays in the top six, so lights don't jump around; freed keys go to the next
 * thread in line. `pinnedThreads` hard-assigns keys.
 */
export function assignCodexMicroSlots(input: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly previous: ReadonlyArray<CodexMicroSlot>;
  readonly mode: CodexMicroAgentMode;
  readonly pinnedThreads: ReadonlyArray<string | null>;
  readonly now: string;
}): CodexMicroSlot[] {
  const byId = new Map(input.threads.map((thread) => [thread.id as string, thread]));
  const pins = Array.from({ length: CODEX_MICRO_SLOT_COUNT }, (_, index) => {
    const id = input.pinnedThreads[index] ?? null;
    return id !== null && byId.has(id) ? id : null;
  });
  const pinned = new Set(pins.filter((id): id is string => id !== null));
  const ranked = rank(input.threads, input.mode, input.now).filter(
    (thread) => !pinned.has(thread.id),
  );
  const chosen = new Set(
    ranked.slice(0, CODEX_MICRO_SLOT_COUNT - pinned.size).map((thread) => thread.id as string),
  );

  const ids: (string | null)[] = [...pins];
  for (const slot of input.previous) {
    if (ids[slot.index] === null && slot.threadId !== null && chosen.has(slot.threadId)) {
      ids[slot.index] = slot.threadId;
      chosen.delete(slot.threadId);
    }
  }
  const rest = ranked.filter((thread) => chosen.has(thread.id));
  for (let index = 0; index < CODEX_MICRO_SLOT_COUNT && rest.length > 0; index += 1) {
    if (ids[index] === null) ids[index] = rest.shift()!.id;
  }

  return ids.map((id, index) => {
    const thread = id === null ? undefined : byId.get(id);
    return thread
      ? {
          index,
          environmentId: thread.environmentId,
          threadId: thread.id,
          title: thread.title,
          status: codexMicroSlotStatus(thread),
        }
      : EMPTY_CODEX_MICRO_SLOTS[index]!;
  });
}
