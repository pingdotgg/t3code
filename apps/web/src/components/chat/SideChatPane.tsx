import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { useClientSettings } from "../../hooks/useSettings";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { readLocalApi } from "../../localApi";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";

/** A side chat tab: its title, Bring back, Delete and Close, over the side chat's own chat. */
export default function SideChatPane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { parentRef, threadId } = props;
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(parentRef.environmentId, threadId), parentRef),
    [parentRef, threadId],
  );
  const shell = useQuietThreadShell(threadRef);
  const parent = useQuietThreadShell(parentRef);
  const snapshotLoaded = useEnvironmentShellHasSnapshot(parentRef.environmentId);
  const projection = useQuietThreadProjection(shell === null ? null : threadRef)?.projection;
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [bringingBack, setBringingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mergeRun = projection ? resolveLatestMergeBackRun(projection) : null;
  // A pending merge-back would fail the main thread's queued message, so the server refuses it.
  const bringBackBlockedReason = !canOperate
    ? "This connection cannot change threads."
    : threadRuntimeIsActive(parent?.runtime)
      ? "Available when the main thread is idle."
      : mergeRun === null
        ? "Available after a finished reply."
        : null;

  const bringBack = async () => {
    if (bringBackBlockedReason !== null || mergeRun === null || bringingBack) return;
    setBringingBack(true);
    const result = await mergeBack({
      environmentId: parentRef.environmentId,
      input: { sourceThreadId: threadId, targetThreadId: parentRef.threadId, runId: mergeRun.id },
    });
    setBringingBack(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Brought back",
        description: "The main thread gets this side chat with your next message there.",
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not bring back the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const deleteSideChat = async () => {
    if (!canOperate || shell === null || deleting) return;
    if (confirmThreadDelete) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Delete side chat "${shell.title}"?`,
            "This permanently clears its conversation history.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    setDeleting(true);
    const result = await deleteThread({
      environmentId: parentRef.environmentId,
      input: { threadId },
    });
    setDeleting(false);
    if (result._tag === "Success") {
      useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadId}`);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not delete the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {shell?.title ?? "Side chat"}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={bringBackBlockedReason !== null || bringingBack || undefined}
                onClick={() => void bringBack()}
              >
                Bring back
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {bringBackBlockedReason ?? "Adds this side chat to the main thread's next message."}
          </TooltipPopup>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Delete side chat"
          disabled={!canOperate || shell === null || deleting}
          onClick={() => void deleteSideChat()}
        >
          <Trash2Icon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close side chat" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      {shell === null ? (
        snapshotLoaded ? (
          <p className="p-3 text-xs text-muted-foreground">This side chat was deleted.</p>
        ) : null
      ) : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={parentRef.environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
