import { useAtomValue } from "@effect/atom-react";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import * as Dialog from "../../components/ui/Dialog";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useNowAfter } from "../../lib/clock";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";
import { useThreadListActions } from "../home/useThreadListActions";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { buildThreadLifecycleMenuItems } from "./threadLifecycleMenu";
import {
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
} from "./threadListV2";
import { useThreadListNow } from "./use-thread-list-now";

export function useThreadLifecycleMenu(thread: EnvironmentThreadShell | null): {
  readonly items: ReadonlyArray<AppBarMenuItem>;
  readonly sheet: ReactNode;
} {
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const { settleThread, unsettleThread, snoozeThread, unsnoozeThread, renameThread } =
    useThreadListActions();
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const settlementSupported =
    thread !== null && listEnvironments.settlementEnvironmentIds.has(thread.environmentId);
  const snoozeSupported =
    thread !== null && listEnvironments.snoozeEnvironmentIds.has(thread.environmentId);
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
          settlementSupported,
          settled,
          snoozeSupported,
          snoozed,
          canSnoozeNow,
          presets,
          canRename: true,
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
          onRename: () => {
            renameThread(thread);
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
