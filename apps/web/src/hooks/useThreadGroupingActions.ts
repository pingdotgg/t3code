import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isListedThreadLineage, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import type {
  ThreadActionMenuId,
  ThreadActionMenuState,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { botFilesEnvironment } from "../state/botFiles";
import { readThreadShells } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

type GroupingThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage" | "groupedUnderThreadId" | "botConfig"
>;

function workersOf(
  leader: Pick<GroupingThread, "environmentId" | "id">,
  threads: ReadonlyArray<GroupingThread>,
): ReadonlyArray<GroupingThread> {
  return threads.filter(
    (thread) =>
      thread.environmentId === leader.environmentId && thread.groupedUnderThreadId === leader.id,
  );
}

/** Subagents and side chats show under their parent, so they neither lead nor join a group. */
export function threadGroupingMenuState(
  thread: GroupingThread,
  threads: ReadonlyArray<GroupingThread> = readThreadShells(),
): ThreadActionMenuState["grouping"] {
  if (!isListedThreadLineage(thread.lineage)) return undefined;
  return {
    isBot: thread.botConfig != null,
    isGrouped: thread.groupedUnderThreadId != null,
    hasWorkers: workersOf(thread, threads).length > 0,
    ...(thread.botConfig == null ? {} : { mutesWorkers: thread.botConfig.muteChildren }),
  };
}

/**
 * The thread a multi-selection groups under: its Bot, else its first thread. Only threads of one
 * project that can join a group qualify, and a thread already leading workers cannot become a worker.
 */
export function resolveBulkGroupLeader<
  T extends GroupingThread & Pick<EnvironmentThreadShell, "projectId">,
>(
  selected: ReadonlyArray<T>,
  threads: ReadonlyArray<GroupingThread> = readThreadShells(),
): T | null {
  const first = selected[0];
  if (first === undefined || selected.length < 2) return null;
  const sameProject = selected.every(
    (thread) =>
      thread.environmentId === first.environmentId &&
      thread.projectId === first.projectId &&
      isListedThreadLineage(thread.lineage),
  );
  if (!sameProject) return null;
  const leader = selected.find((thread) => thread.botConfig != null) ?? first;
  if (leader.groupedUnderThreadId != null) return null;
  const leadsWorkers = selected.some(
    (thread) => thread !== leader && workersOf(thread, threads).length > 0,
  );
  return leadsWorkers ? null : leader;
}

export type ThreadGroupingAction = Extract<
  ThreadActionMenuId,
  "start-bot" | "remove-from-group" | "ungroup" | "mute-workers" | "unmute-workers"
>;

export function isThreadGroupingAction(action: ThreadActionMenuId): action is ThreadGroupingAction {
  return (
    action === "start-bot" ||
    action === "remove-from-group" ||
    action === "ungroup" ||
    action === "mute-workers" ||
    action === "unmute-workers"
  );
}

function reportFailure(title: string, result: Parameters<typeof isAtomCommandInterrupted>[0]) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description:
        thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred.")),
    }),
  );
}

export function useThreadGroupingActions() {
  const setGroup = useOrchestrationCommand(threadEnvironment.setGroup, { reportFailure: false });
  const setBotMuteChildren = useOrchestrationCommand(threadEnvironment.setBotMuteChildren, {
    reportFailure: false,
  });
  const startBotCommand = useAtomCommand(botFilesEnvironment.start, { reportFailure: false });
  const router = useRouter();

  const group = async (threadRef: ScopedThreadRef, leaderId: ThreadId | null) =>
    setGroup({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, groupedUnderThreadId: leaderId },
    });

  const setMuteWorkers = async (threadRef: ScopedThreadRef, muted: boolean) => {
    const result = await setBotMuteChildren({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, botMuteChildren: muted },
    });
    reportFailure(m(msg("Failed to update Bot")), result);
  };

  /** A new Bot that takes this thread as its first worker; opens the Bot. */
  const startBot = async (threadRef: ScopedThreadRef) => {
    const result = await startBotCommand({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    reportFailure(m(msg("Failed to start a Bot")), result);
    if (result._tag !== "Success") return;
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(threadRef.environmentId, result.value.threadId),
      ),
    });
  };

  const run = async (action: ThreadGroupingAction, threadRef: ScopedThreadRef) => {
    switch (action) {
      case "start-bot":
        return startBot(threadRef);
      case "mute-workers":
        return setMuteWorkers(threadRef, true);
      case "unmute-workers":
        return setMuteWorkers(threadRef, false);
      case "remove-from-group":
        return reportFailure(m(msg("Failed to update group")), await group(threadRef, null));
      case "ungroup": {
        const workers = workersOf(
          { environmentId: threadRef.environmentId, id: threadRef.threadId },
          readThreadShells(),
        );
        for (const member of workers) {
          const result = await group(
            { environmentId: member.environmentId, threadId: member.id },
            null,
          );
          reportFailure(m(msg("Failed to update group")), result);
        }
        return;
      }
    }
  };

  /** Groups the other selected threads under `leader`, the first listed one. */
  const groupUnder = async (
    leader: ScopedThreadRef,
    members: ReadonlyArray<ScopedThreadRef>,
  ): Promise<void> => {
    for (const member of members) {
      if (member.environmentId !== leader.environmentId || member.threadId === leader.threadId) {
        continue;
      }
      reportFailure(m(msg("Failed to update group")), await group(member, leader.threadId));
    }
  };

  return { run, setMuteWorkers, startBot, groupUnder };
}
