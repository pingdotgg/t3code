import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadProjection, useThreadHistory } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { requestPromptJump } from "../chat/promptJumpStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";
import { sidebarPromptMessages } from "./SidebarThreadPrompts.logic";

export function SidebarThreadPrompts(props: {
  readonly thread: EnvironmentThreadShell;
  readonly onSelectThread: (threadRef: ScopedThreadRef) => void;
}) {
  const environmentId = props.thread.environmentId;
  const threadId = props.thread.id;
  const threadRef = { environmentId, threadId };
  const threadKey = scopedThreadKey(threadRef);
  const detail = useQuietThreadProjection(threadRef)?.projection ?? null;
  const history = useThreadHistory(threadRef);
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load prompts for sidebar thread",
    reportFailure: false,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the next history page while this expanded prompt index is mounted
  useEffect(() => {
    if (!detail || !history.hasMoreHistory || history.loading || history.error !== null) return;
    void loadEarlierHistory({
      environmentId,
      input: { threadId },
    });
  }, [
    detail,
    environmentId,
    history.error,
    history.hasMoreHistory,
    history.loading,
    loadEarlierHistory,
    threadId,
  ]);

  const prompts = sidebarPromptMessages(detail?.messages ?? []);

  return (
    <li role="presentation" className="list-none">
      <ol aria-label={`Prompts in ${props.thread.title}`} data-testid="sidebar-thread-prompts">
        {prompts.map((message, index) => {
          const preview = message.text.replace(/\s+/gu, " ").trim();
          return (
            <li key={message.id} role="presentation" className="list-none">
              <button
                type="button"
                role="treeitem"
                tabIndex={-1}
                data-sidebar-row={`prompt:${message.id}`}
                data-sidebar-parent={threadKey}
                aria-label={`Prompt ${index + 1}: ${preview || "Attachment or empty prompt"}`}
                className="flex min-h-8 w-full cursor-pointer items-start gap-2 rounded-md py-1 pe-2 ps-14 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => {
                  requestPromptJump(threadKey, message.id);
                  props.onSelectThread(threadRef);
                }}
              >
                <span className="shrink-0 pt-0.5 tabular-nums">{index + 1}.</span>
                <span className="line-clamp-2 min-w-0 break-words">
                  {preview || "Attachment or empty prompt"}
                </span>
              </button>
            </li>
          );
        })}
        {prompts.length === 0 && history.error === null && (history.hasMoreHistory || !detail) ? (
          <li
            role="presentation"
            className="list-none px-14 py-2 text-xs text-sidebar-muted-foreground"
          >
            Loading prompts…
          </li>
        ) : null}
        {history.error !== null ? (
          <li
            role="presentation"
            className="flex list-none items-center gap-2 px-14 py-2 text-xs text-destructive"
          >
            <span>Could not load all prompts</span>
            <button
              type="button"
              data-sidebar-action-for={threadKey}
              className="cursor-pointer underline underline-offset-2"
              onClick={() =>
                void loadEarlierHistory({
                  environmentId,
                  input: { threadId },
                })
              }
            >
              Retry
            </button>
          </li>
        ) : null}
        {prompts.length === 0 && detail && !history.hasMoreHistory && history.error === null ? (
          <li
            role="presentation"
            className="list-none px-14 py-2 text-xs text-sidebar-muted-foreground"
          >
            No prompts in this thread
          </li>
        ) : null}
      </ol>
    </li>
  );
}
