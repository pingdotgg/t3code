import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { RelativeTime } from "../RelativeTime";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { boardVisitKey, presentBoardTopic, resolveBoardLeadShell } from "./boardPanel.logic";

export function BoardPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}) {
  const { threadRef, cwd } = props;
  const { environmentId, threadId } = threadRef;
  const shells = useQuietThreadShells();
  const shellById = new Map(
    shells.filter((shell) => shell.environmentId === environmentId).map((s) => [s.id, s]),
  );
  const leadShell = resolveBoardLeadShell(shells, environmentId, threadId);
  const boardUpdatedAt = leadShell?.boardUpdatedAt ?? null;
  const board = useEnvironmentQuery(
    orchestrationEnvironment.threadBoard({ environmentId, input: { threadId } }),
  );
  const refreshBoard = board.refresh;
  const visitBoard = useAtomCommand(threadEnvironment.visitBoard, { reportFailure: false });

  // The first load's watermark outlives the visit it triggers, so topics stay marked while open.
  const [watermark, setWatermark] = useState<{ readonly viewedAt: string | null } | null>(null);
  if (watermark === null && board.data !== null) setWatermark({ viewedAt: board.data.viewedAt });

  const lastRefreshedFor = useRef(boardUpdatedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server read when an agent posts, which only the shell reports
  useEffect(() => {
    if (lastRefreshedFor.current === boardUpdatedAt) return;
    lastRefreshedFor.current = boardUpdatedAt;
    refreshBoard();
  }, [boardUpdatedAt, refreshBoard]);

  const leadThreadId = board.data?.leadThreadId ?? null;
  const visitKey = board.data === null ? null : boardVisitKey(board.data.topics);
  const lastVisitKey = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server the board was seen, once per opening and per batch of new topics
  useEffect(() => {
    if (leadThreadId === null || visitKey === null || lastVisitKey.current === visitKey) return;
    lastVisitKey.current = visitKey;
    void visitBoard({
      environmentId,
      input: { threadId: leadThreadId, viewedAt: new Date().toISOString() },
    });
  }, [environmentId, leadThreadId, visitBoard, visitKey]);

  if (board.data === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {board.error ?? (board.isPending ? "Loading board…" : null)}
      </p>
    );
  }
  if (board.data.topics.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No topics yet. Agents in this group post their current state here.
      </p>
    );
  }
  const viewedAt = watermark?.viewedAt ?? board.data.viewedAt;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul className="flex flex-col divide-y divide-border">
        {board.data.topics.map((topic) => {
          const presentation = presentBoardTopic(topic, viewedAt);
          const editor = shellById.get(topic.lastEditorThreadId) ?? null;
          const status = editor ? resolveThreadStatusPill({ thread: editor }) : null;
          return (
            <li
              key={topic.id}
              className="flex flex-col gap-2 px-4 py-3"
              aria-label={`${topic.title} board topic`}
            >
              <div className="flex items-center gap-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{topic.title}</h3>
                {presentation.updated ? (
                  <Badge variant="info" size="sm">
                    Updated
                  </Badge>
                ) : null}
              </div>
              <ChatMarkdown
                text={topic.text}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                isStreaming={false}
              />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <RelativeTime timestamp={topic.updatedAt} />
                {editor ? (
                  <span className="inline-flex min-w-0 max-w-56 items-center gap-1.5">
                    <span
                      role="img"
                      aria-label={status?.label ?? "Idle"}
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        status?.dotClass ?? "bg-muted-foreground/40",
                        status?.pulse ? "motion-safe:animate-status-pulse" : "",
                      )}
                    />
                    <span className="truncate">{editor.title}</span>
                  </span>
                ) : null}
                {presentation.editedLabel ? <span>{presentation.editedLabel}</span> : null}
                {presentation.authorLeft ? <span>Author left the group</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
