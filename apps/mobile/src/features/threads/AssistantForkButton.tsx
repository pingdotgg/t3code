import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import {
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Platform, Pressable, type ColorValue } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useCaptureThreadNavigation } from "./thread-navigation-capture";
import { waitForThreadShell } from "./threadForkNavigation";

export function AssistantForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly sourceTitle: string;
}) {
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const gt = useGT();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork from response");
  const captureThreadNavigation = useCaptureThreadNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const [busy, setBusy] = useState(false);
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;

  if (!canFork || runId === null) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Fork from this response")}
      disabled={busy}
      onPress={() => {
        const isSourceCurrent = captureThreadNavigation();
        const targetThreadId = ThreadId.make(uuidv4());
        setBusy(true);
        void Haptics.selectionAsync();
        void forkFromRun({
          environmentId: props.environmentId,
          input: {
            sourceThreadId: props.projectedItem.sourceThreadId,
            targetThreadId,
            runId,
            title: `${props.sourceTitle} fork`,
            creationSource: "mobile",
          },
        })
          .then(async (result) => {
            if (isAtomCommandInterrupted(result)) return;
            if (result._tag !== "Success") {
              Dialog.alert(
                gt("Could not confirm fork"),
                gt("Reconnect and check the thread list before trying again."),
              );
              return;
            }
            const targetThreadReady = await waitForThreadShell(
              scopeThreadRef(props.environmentId, targetThreadId),
            );
            if (!targetThreadReady) {
              Dialog.alert(
                gt("Fork created"),
                gt(
                  "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
                ),
              );
              return;
            }
            if (!isSourceCurrent()) return;
            selectDetail({
              name: "Thread",
              params: { environmentId: props.environmentId, threadId: targetThreadId },
            });
          })
          .finally(() => setBusy(false));
      }}
      className="h-7 w-7 items-center justify-center disabled:opacity-40"
      style={
        Platform.OS === "android"
          ? { width: props.buttonSize, height: props.buttonSize }
          : undefined
      }
    >
      {busy ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.triangle.branch"
          size={props.iconSize}
          tintColor={props.iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}
