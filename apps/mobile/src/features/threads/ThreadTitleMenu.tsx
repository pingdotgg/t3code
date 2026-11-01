import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useThreadListActions } from "../home/useThreadListActions";
import { useWorkspaceListNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import {
  buildThreadTitleMenu,
  threadTitleMenuOffers,
  threadTitleSnoozeUntil,
} from "./thread-title-menu";
import { leaveDeletedThread } from "./thread-title-delete-navigation";
import { ThreadTitleMenuTrigger } from "./ThreadTitleMenuTrigger";
import { Platform, View } from "react-native";

export function ThreadTitleMenu(props: {
  readonly thread: EnvironmentThreadShell;
  /** False until the server owns the thread; only Copy thread ID stays available. */
  readonly canMutate: boolean;
  readonly subtitle: string;
  readonly maxWidth: number;
  /** Android only: one row with the subtitle after the title, matching AndroidScreenHeader. */
  readonly compact?: boolean;
}) {
  const { thread } = props;
  const configs = useAtomValue(environmentServerConfigsAtom);
  const queuedKeys = useAtomValue(queuedThreadKeysAtom);
  const canOperate =
    useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) && props.canMutate;
  const handlers = useThreadListActions();
  const navigation = useNavigation();
  const returnToList = useWorkspaceListNavigation("threads");
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // Losing mutations closes an open custom snooze sheet before it can submit.
  if (customSnoozeOpen && !canOperate) setCustomSnoozeOpen(false);
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      const timer = setInterval(() => setNow(new Date()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  const actions = buildThreadTitleMenu({
    thread,
    capabilities: configs.get(thread.environmentId)?.environment.capabilities,
    snoozePresets: configs.get(thread.environmentId)?.settings.snoozePresets,
    canOperate,
    hasQueuedMessages: queuedKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
    now,
  });
  const android = Platform.OS === "android";
  const inlineSubtitle = android && props.compact && props.subtitle !== "";
  const snooze = (until: string) => {
    void handlers.snoozeThread(thread, until);
  };
  return (
    <>
      <ThreadTitleMenuTrigger
        maxWidth={props.maxWidth}
        actions={actions}
        title={thread.title}
        onOpen={() => setNow(new Date())}
        onAction={(event) => {
          if (!threadTitleMenuOffers(actions, event)) return;
          switch (event) {
            case "settle":
              void handlers.settleThread(thread);
              return;
            case "unsettle":
              void handlers.unsettleThread(thread);
              return;
            case "unsnooze":
              void handlers.unsnoozeThread(thread);
              return;
            case "pin":
              void handlers.pinThread(thread);
              return;
            case "unpin":
              void handlers.unpinThread(thread);
              return;
            case "rename":
              handlers.renameThread(thread);
              return;
            case "regenerate-title":
              void handlers.regenerateThreadTitle(thread);
              return;
            case "delete":
              handlers.confirmDeleteThread(thread, () =>
                leaveDeletedThread(navigation, thread, android ? returnToList : undefined),
              );
              return;
            case "copy-thread-id":
              void copyTextWithHaptic(thread.id, { target: "thread-id" });
              return;
            case "snooze:custom":
              setCustomSnoozeOpen(true);
              return;
          }
          const until = threadTitleSnoozeUntil(event, new Date());
          if (until !== null) snooze(until);
          else if (event.startsWith("snooze:"))
            Dialog.alert(
              "Could not snooze thread",
              "That snooze time has passed. Choose another time.",
            );
        }}
      >
        {/* Android matches AndroidScreenHeader's start-aligned, scaled title roles. */}
        <View className="min-w-0">
          <View
            className={
              android
                ? "min-w-0 flex-row items-center gap-1"
                : "min-w-0 flex-row items-center justify-center gap-1"
            }
          >
            <AppText
              numberOfLines={1}
              textRole={android ? "title" : undefined}
              className={
                android
                  ? "shrink text-header-foreground"
                  : "shrink text-[17px] font-t3-bold text-header-foreground"
              }
            >
              {thread.title}
            </AppText>
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName="accent-foreground-muted"
            />
            {inlineSubtitle ? (
              <AppText
                numberOfLines={1}
                textRole="label"
                className="ml-1 flex-1 text-foreground-muted"
              >
                {props.subtitle}
              </AppText>
            ) : null}
          </View>
          {props.subtitle && !inlineSubtitle ? (
            <AppText
              numberOfLines={1}
              textRole="label"
              className={android ? "text-foreground-muted" : "text-center text-foreground-muted"}
            >
              {props.subtitle}
            </AppText>
          ) : null}
        </View>
      </ThreadTitleMenuTrigger>
      {customSnoozeOpen ? (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={snooze} />
      ) : null}
    </>
  );
}
