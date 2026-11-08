import { useAtomValue } from "@effect/atom-react";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Platform } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useNowAfter } from "../../lib/clock";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useThreadListActions } from "../home/useThreadListActions";
import { threadCanArchive } from "../home/threadArchive";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { getThreadListV2NewBranchMenuTitle } from "./thread-list-v2-row-appearance";
import { buildThreadLifecycleMenuItems } from "./threadLifecycleMenu";
import {
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
} from "./threadListV2";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import { useThreadListNow } from "./use-thread-list-now";

export function useThreadLifecycleMenu(thread: EnvironmentThreadShell | null): {
  readonly items: ReadonlyArray<AppBarMenuItem>;
  readonly sheet: ReactNode;
} {
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
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
  const arrangeSupported =
    thread !== null &&
    (thread.pinnedAt != null
      ? listEnvironments.pinReorderEnvironmentIds.has(thread.environmentId)
      : listEnvironments.activeReorderEnvironmentIds.has(thread.environmentId));
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
  const presets = resolveThreadListV2SnoozePresets({
    secondary: snoozeSupported && !snoozed ? "snooze" : null,
    now,
    presets: snoozePresets,
  });

  const handleSnooze = (snoozedUntil: string) => {
    if (thread === null) return;
    void snoozeThread(thread, snoozedUntil);
  };

  const items =
    thread !== null && canOperate
      ? buildThreadLifecycleMenuItems({
          nested: Platform.OS === "ios",
          settlementSupported,
          settled,
          snoozeSupported,
          snoozed,
          canSnoozeNow,
          presets,
          branch: thread.branch,
          newBranchTitle: getThreadListV2NewBranchMenuTitle(thread.branch ?? ""),
          pinned: thread.pinnedAt != null,
          pinningSupported,
          arrangeSupported,
          titleRegenerationSupported,
          regeneratingTitle: thread.titleRegeneration != null,
          canTurnIntoProject: canTurnThreadIntoProject(thread),
          turnIntoProjectDisabled: !threadCanArchive(thread.runtime),
          autoSettleOptOutSupported,
          autoSettleEnabled: thread.autoSettleDisabledAt == null,
          canRename: true,
          onNewThreadOnBranch: () => {
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
          },
          onCopyThread: () => {
            const target = threadChipCopyTarget(
              { environmentId: thread.environmentId, threadId: thread.id },
              thread.title,
            );
            void copyThreadReference(target).then((didCopy) => {
              if (!didCopy) Dialog.alert(target.failureTitle, "Try copying this thread again.");
            });
          },
          onCopyThreadId: () => {
            copyTextWithHaptic(thread.id, { target: "thread-id" });
          },
          onSettle: () => {
            void settleThread(thread);
          },
          onUnsettle: () => {
            void unsettleThread(thread);
          },
          onWake: () => {
            void unsnoozeThread(thread);
          },
          onSnoozePreset: (presetId) => {
            const selection = resolveThreadListV2SnoozeMenuSelection({
              event: `snooze:${presetId}`,
              displayedPresets: presets,
              // Same clock the presets were rendered against; avoid `new Date()` in render.
              now: Date.parse(now),
              presets: snoozePresets,
            });
            if (selection._tag === "selected") {
              handleSnooze(selection.preset.snoozedUntil);
            } else if (selection._tag === "expired") {
              Dialog.alert(
                "Could not snooze thread",
                "That snooze time has passed. Choose another time.",
              );
            }
          },
          onCustomSnooze: () => setCustomSnoozeOpen(true),
          onPin: () => {
            void pinThread(thread);
          },
          onUnpin: () => {
            void unpinThread(thread);
          },
          onArrange: () => {
            appAtomRegistry.set(threadArrangementOpenAtom, true);
          },
          onRename: () => {
            renameThread(thread);
          },
          onRegenerateTitle: () => {
            void regenerateThreadTitle(thread);
          },
          onTurnIntoProject: () => {
            void turnThreadIntoProject(thread);
          },
          onSetAutoSettle: (enabled) => {
            void setThreadAutoSettle(thread, enabled);
          },
          onArchive: () => {
            void archiveThread(thread);
          },
          onDelete: () => {
            confirmDeleteThread(thread);
          },
        })
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
