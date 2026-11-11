import { useAtomValue } from "@effect/atom-react";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Platform } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { appBarMenuItemsFromActions } from "../../components/ui/menuActionItems";
import { useNowAfter } from "../../lib/clock";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";
import { getPendingThreadOrder, threadArrangementOpenAtom } from "../../state/thread-order";
import { environmentThreadShells } from "../../state/threads";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useThreadListActions } from "../home/useThreadListActions";
import { threadCanArchive } from "../home/threadArchive";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { buildThreadListV2RowMenuActions } from "./thread-list-v2-row-menu";
import { computeThreadMoveAvailability } from "./threadOrder";
import {
  getThreadListV2OrderedSection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
  resolveThreadListV2SwipeActions,
} from "./threadListV2";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import { useThreadListNow } from "./use-thread-list-now";

export function useThreadLifecycleMenu(
  thread: EnvironmentThreadShell | null,
  options: {
    /** Called after a successful Settle or Snooze, which put the thread away. */
    readonly onPutAway?: (thread: EnvironmentThreadShell) => void;
  } = {},
): {
  readonly items: ReadonlyArray<AppBarMenuItem>;
  readonly sheet: ReactNode;
} {
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const shells = useAtomValue(environmentThreadShells.navigationThreadShellsAtom);
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    renameThread,
    archiveThread,
    confirmDeleteThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    regenerateThreadTitle,
    moveThread,
  } = useThreadListActions();
  const selectDetail = useSelectWorkspaceDetail();
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const settlementSupported =
    thread !== null && listEnvironments.settlementEnvironmentIds.has(thread.environmentId);
  const snoozeSupported =
    thread !== null && listEnvironments.snoozeEnvironmentIds.has(thread.environmentId);
  const pinningSupported =
    thread !== null && listEnvironments.pinningEnvironmentIds.has(thread.environmentId);
  const titleRegenerationSupported =
    thread !== null && listEnvironments.titleRegenerationEnvironmentIds.has(thread.environmentId);
  const autoSettleOptOutSupported =
    thread !== null && listEnvironments.autoSettleOptOutEnvironmentIds.has(thread.environmentId);
  const snoozePresets =
    thread === null
      ? undefined
      : listEnvironments.snoozePresetsByEnvironmentId.get(thread.environmentId);
  const now = useThreadListNow(thread ? [thread] : []);
  const snoozeGateExpiryMs =
    thread !== null && snoozeSupported
      ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: thread.latestUserMessageAt ?? "" })
      : null;
  const snoozeGateNowMs = useNowAfter(snoozeGateExpiryMs === null ? null : snoozeGateExpiryMs + 1);
  const snoozeGateNow = new Date(snoozeGateNowMs).toISOString();
  const settled = thread?.settledOverride === "settled";
  const snoozed = thread !== null && effectiveSnoozed(thread, { now });
  const canSnoozeNow = thread !== null && canSnooze(thread, { now: snoozeGateNow });
  const swipeActions =
    thread === null
      ? { primary: "archive" as const, secondary: null }
      : resolveThreadListV2SwipeActions({
          variant: settled ? "slim" : "card",
          settlementSupported,
          snoozeSupported,
          snoozable: canSnoozeNow,
          snoozed,
        });
  const presets = resolveThreadListV2SnoozePresets({
    secondary: swipeActions.secondary,
    now,
    presets: snoozePresets,
  });
  const snoozePresetActions = [
    ...presets.map((preset) => ({
      id: `snooze:${preset.id}`,
      title: preset.label,
      subtitle: preset.whenLabel,
    })),
    { id: "snooze:custom", title: "Custom…" },
  ];

  const reorderSupported =
    thread !== null &&
    (thread.pinnedAt != null
      ? listEnvironments.pinReorderEnvironmentIds.has(thread.environmentId)
      : listEnvironments.activeReorderEnvironmentIds.has(thread.environmentId));

  const moveAvailability = (() => {
    if (thread === null || !reorderSupported || snoozed || settled) {
      return { canMoveUp: false, canMoveDown: false };
    }
    const section = thread.pinnedAt != null ? "pinned" : "active";
    const ordered = getThreadListV2OrderedSection({
      threads: shells,
      section,
      now,
      queuedThreadKeys: new Set(),
      settlementEnvironmentIds: listEnvironments.settlementEnvironmentIds,
      snoozeEnvironmentIds: listEnvironments.snoozeEnvironmentIds,
    });
    const reorderableEnvironmentIds =
      section === "pinned"
        ? listEnvironments.pinReorderEnvironmentIds
        : listEnvironments.activeReorderEnvironmentIds;
    const availability = computeThreadMoveAvailability({
      ordered,
      allThreads: shells,
      section,
      reorderableEnvironmentIds,
      pendingOrder: getPendingThreadOrder(),
    });
    return (
      availability.get(scopedThreadKey(thread.environmentId, thread.id)) ?? {
        canMoveUp: false,
        canMoveDown: false,
      }
    );
  })();

  const handleSnooze = (snoozedUntil: string) => {
    if (thread === null) return;
    void snoozeThread(thread, snoozedUntil).then((snoozed) => {
      if (snoozed) options.onPutAway?.(thread);
    });
  };

  const handleMenuAction = (event: string) => {
    if (thread === null) return;
    if (event === "new-thread-on-branch") {
      selectDetail({
        name: "Thread",
        params: {
          draft: {
            requestId: uuidv4(),
            environmentId: String(thread.environmentId),
            projectId: String(thread.projectId),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
          },
        },
      });
      return;
    }
    if (event === "settle") {
      void settleThread(thread).then((settled) => {
        if (settled) options.onPutAway?.(thread);
      });
      return;
    }
    if (event === "unsettle") {
      void unsettleThread(thread);
      return;
    }
    if (event === "unsnooze") {
      void unsnoozeThread(thread);
      return;
    }
    if (event === "pin") {
      void pinThread(thread);
      return;
    }
    if (event === "unpin") {
      void unpinThread(thread);
      return;
    }
    if (event === "auto-settle:enabled") {
      void setThreadAutoSettle(thread, true);
      return;
    }
    if (event === "auto-settle:disabled") {
      void setThreadAutoSettle(thread, false);
      return;
    }
    if (event === "arrange") {
      appAtomRegistry.set(threadArrangementOpenAtom, true);
      return;
    }
    if (event === "move-up") {
      void moveThread(thread, "up");
      return;
    }
    if (event === "move-down") {
      void moveThread(thread, "down");
      return;
    }
    if (event === "archive") {
      void archiveThread(thread);
      return;
    }
    if (event === "rename") {
      renameThread(thread);
      return;
    }
    if (event === "regenerate-title") {
      void regenerateThreadTitle(thread);
      return;
    }
    if (event === "turn-into-project") {
      void turnThreadIntoProject(thread);
      return;
    }
    if (event === "copy-thread") {
      const target = threadChipCopyTarget(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.title,
      );
      void copyThreadReference(target).then((didCopy) => {
        if (!didCopy) Dialog.alert(target.failureTitle, "Try copying this thread again.");
      });
      return;
    }
    if (event === "copy-thread-id") {
      copyTextWithHaptic(thread.id, { target: "thread-id" });
      return;
    }
    if (event === "delete") {
      confirmDeleteThread(thread);
      return;
    }
    if (event === "snooze:custom") {
      setCustomSnoozeOpen(true);
      return;
    }
    const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
      event,
      displayedPresets: presets,
      // Same clock the presets were rendered against; avoid `new Date()` in render.
      now: Date.parse(now),
      presets: snoozePresets,
    });
    if (snoozeSelection._tag === "selected") {
      handleSnooze(snoozeSelection.preset.snoozedUntil);
    } else if (snoozeSelection._tag === "expired") {
      Dialog.alert("Could not snooze thread", "That snooze time has passed. Choose another time.");
    }
  };

  const items =
    thread !== null && canOperate
      ? appBarMenuItemsFromActions(
          buildThreadListV2RowMenuActions({
            thread,
            nested: Platform.OS === "ios",
            settlementSupported,
            snoozed,
            settled,
            includeSnooze: swipeActions.secondary === "snooze",
            snoozePresetActions,
            pinningSupported,
            reorderSupported,
            canMoveUp: moveAvailability.canMoveUp,
            canMoveDown: moveAvailability.canMoveDown,
            titleRegenerationSupported,
            canTurnIntoProject: canTurnThreadIntoProject(thread),
            turnIntoProjectDisabled: !threadCanArchive(thread.runtime),
            autoSettleOptOutSupported,
          }),
          handleMenuAction,
        )
      : [];

  const sheet =
    customSnoozeOpen && thread !== null ? (
      <CustomSnoozeSheet
        onClose={() => setCustomSnoozeOpen(false)}
        onSnooze={(snoozedUntil) => {
          setCustomSnoozeOpen(false);
          handleSnooze(snoozedUntil);
        }}
      />
    ) : null;

  return { items, sheet };
}
