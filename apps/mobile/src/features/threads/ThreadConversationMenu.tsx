import { QUEUED_TURN_START_GRACE_MS } from "@t3tools/client-runtime/state/thread-settled";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StackActions, useNavigation } from "@react-navigation/native";
import type { ScreenHeaderMenu } from "../../components/ScreenHeader.types";
import { environmentServerConfigsAtom } from "../../state/server";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useArchivedThreadListActions, useThreadListActions } from "../home/useThreadListActions";
import { threadActionCanReturnHome, threadConversationActions } from "./threadConversationActions";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";

const ignoreUnarchiveCompletion = () => {};

/** Uses the same mutations and confirmations as both list modes, bound to the opened thread. */
export function useThreadConversationMenu(thread: EnvironmentThreadShell | null) {
  const navigation = useNavigation();
  const completed = useCallback(
    (action: string, target: EnvironmentThreadShell) => {
      if (action !== "archive" && action !== "delete") return;
      const state = navigation.getState();
      const params = state?.routes[state.index]?.params;
      if (!navigation.isFocused() || !threadActionCanReturnHome(params, target)) return;
      navigation.dispatch(StackActions.replace("Home"));
    },
    [navigation],
  );
  const actions = useThreadListActions(completed);
  const archived = useArchivedThreadListActions(ignoreUnarchiveCompletion);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const queued = useAtomValue(queuedThreadKeysAtom);
  const [clock, refreshClock] = useState(0);
  useEffect(() => {
    const boundaries = [thread?.snoozedUntil, thread?.latestUserMessageAt].flatMap(
      (time, index) => {
        if (!time) return [];
        const end = Date.parse(time) + (index === 1 ? QUEUED_TURN_START_GRACE_MS : 0);
        return end > Date.now() ? [end] : [];
      },
    );
    if (!boundaries.length) return;
    const timer = setTimeout(
      () => refreshClock((value) => value + 1),
      Math.min(Math.min(...boundaries) - Date.now() + 50, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [thread?.snoozedUntil, thread?.latestUserMessageAt, clock]);
  const [snoozeTarget, setSnoozeTarget] = useState<EnvironmentThreadShell | null>(null);
  useEffect(() => {
    setSnoozeTarget(null);
  }, [thread?.id, thread?.environmentId]);
  const capability = thread
    ? configs.get(thread.environmentId)?.environment.capabilities
    : undefined;
  const menu = useMemo<ScreenHeaderMenu | undefined>(
    () =>
      thread
        ? {
            title: "Thread actions",
            icon: "ellipsis.circle",
            items: threadConversationActions(
              thread,
              capability ?? {},
              new Date().toISOString(),
              queued.has(scopedThreadKey(thread.environmentId, thread.id)),
            ).map((item) => ({
              ...item,
              onPress: () => {
                switch (item.id) {
                  case "rename":
                    actions.renameThread(thread);
                    break;
                  case "regenerate":
                    void actions.regenerateThreadTitle(thread);
                    break;
                  case "pin":
                    void actions.pinThread(thread);
                    break;
                  case "unpin":
                    void actions.unpinThread(thread);
                    break;
                  case "settle":
                    void actions.settleThread(thread);
                    break;
                  case "unsettle":
                    void actions.unsettleThread(thread);
                    break;
                  case "snooze":
                    setSnoozeTarget(thread);
                    break;
                  case "unsnooze":
                    void actions.unsnoozeThread(thread);
                    break;
                  case "archive":
                    actions.archiveThread(thread);
                    break;
                  case "unarchive":
                    archived.unarchiveThread(thread);
                    break;
                  case "delete":
                    actions.confirmDeleteThread(thread);
                    break;
                }
              },
            })),
          }
        : undefined,
    [
      thread,
      capability,
      queued,
      clock,
      actions.renameThread,
      actions.regenerateThreadTitle,
      actions.pinThread,
      actions.unpinThread,
      actions.settleThread,
      actions.unsettleThread,
      actions.unsnoozeThread,
      actions.archiveThread,
      actions.confirmDeleteThread,
      archived.unarchiveThread,
    ],
  );
  const sheet =
    snoozeTarget &&
    thread?.id === snoozeTarget.id &&
    thread.environmentId === snoozeTarget.environmentId ? (
      <CustomSnoozeSheet
        onClose={() => setSnoozeTarget(null)}
        onSnooze={(until) => {
          void actions.snoozeThread(snoozeTarget, until);
        }}
      />
    ) : null;
  return { menu, sheet };
}
