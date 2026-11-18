import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { T, useGT } from "gt-react";
import { Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { ComposerHandleContext } from "../../composerHandleContext";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { readLocalApi } from "../../localApi";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";

/** A side chat tab: its title, Add to chat, Delete and Close, over the side chat's own chat. */
export default function SideChatPane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { parentRef, threadId } = props;
  const gt = useGT();
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(parentRef.environmentId, threadId), parentRef),
    [parentRef, threadId],
  );
  const shell = useQuietThreadShell(threadRef);
  const snapshotLoaded = useEnvironmentShellHasSnapshot(parentRef.environmentId);
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [deleting, setDeleting] = useState(false);
  // Closing an unused side chat deletes it, which would leave the link unreadable.
  const canAddToChat = shell !== null && shell.latestUserMessageAt !== null;
  const addToChat = () => {
    if (!canAddToChat) return;
    useComposerDraftStore
      .getState()
      .addThreadContexts(parentRef, [threadContextRecord(threadRef, shell.title)], {
        insertAtCaret: false,
      });
  };

  const deleteSideChat = async () => {
    if (!canOperate || shell === null || deleting) return;
    if (confirmThreadDelete) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            gt('Delete side chat "{title}"?', { title: shell.title }),
            gt("This permanently clears its conversation history."),
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
      releaseComposerDraftUploads(threadRef);
      useComposerDraftStore.getState().clearDraftThread(threadRef);
      useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadId}`);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not delete the side chat"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <div data-side-chat-pane={threadId} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {shell?.title ?? gt("Side chat")}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={!canAddToChat || undefined}
                onClick={addToChat}
              >
                <T>Add to chat</T>
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {canAddToChat
              ? gt("Adds this side chat to the main thread's next message.")
              : gt("Available after the first message.")}
          </TooltipPopup>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Delete side chat")}
          disabled={!canOperate || shell === null || deleting}
          onClick={() => void deleteSideChat()}
        >
          <Trash2Icon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={gt("Close side chat")}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      {shell === null ? (
        snapshotLoaded ? (
          <p className="p-3 text-xs text-muted-foreground">
            <T>This side chat was deleted.</T>
          </p>
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
