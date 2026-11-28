import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ThreadDetailsCard } from "../chat/ThreadDetailsCard";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { BotNotes } from "./BotNotes";
import { useBotBoard } from "./useBotBoard";

const STATUS_DOT = {
  needsYou: "bg-warning",
  working: "bg-info",
  done: "bg-muted-foreground/40",
} as const;

function WorkerRow(props: {
  thread: EnvironmentThreadShell;
  status: keyof typeof STATUS_DOT;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const project = useProject(scopeProjectRef(props.thread.environmentId, props.thread.projectId));
  const projectName = project?.isScratch ? gt("No project") : (project?.title ?? null);
  return (
    <li>
      <ThreadDetailsControl
        onClick={() => props.onOpen(scopeThreadRef(props.thread.environmentId, props.thread.id))}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[props.status])} />
        </span>
        <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
          {props.thread.title}
        </span>
        {projectName === null ? null : (
          <span className="max-w-1/3 shrink-0 truncate text-xs font-normal text-muted-foreground">
            {projectName}
          </span>
        )}
      </ThreadDetailsControl>
    </li>
  );
}

function WorkerRows(props: {
  status: keyof typeof STATUS_DOT;
  workers: ReadonlyArray<EnvironmentThreadShell>;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  return props.workers.map((thread) => (
    <WorkerRow key={thread.id} thread={thread} status={props.status} onOpen={props.onOpen} />
  ));
}

/** Workers that need you or are working stay in view; finished ones fold away, like lineage. */
function BotWorkers(props: {
  board: ReturnType<typeof useBotBoard>;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const [doneOpen, setDoneOpen] = useState(false);
  const { needsYou, working, done } = props.board;
  return (
    <div>
      {needsYou.length + working.length === 0 ? null : (
        <ul aria-label={gt("Active workers")} className="m-0 list-none p-0">
          <WorkerRows status="needsYou" workers={needsYou} onOpen={props.onOpen} />
          <WorkerRows status="working" workers={working} onOpen={props.onOpen} />
        </ul>
      )}
      {done.length === 0 ? null : (
        <>
          <ThreadDetailsControl aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
            <CheckIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
              {gt("Done")}
            </span>
            {doneOpen ? null : (
              <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
                {done.length}
              </span>
            )}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                THREAD_DETAILS_PANEL_CHEVRON_CLASS,
                "transition-transform",
                !doneOpen && "-rotate-90",
              )}
            />
          </ThreadDetailsControl>
          {doneOpen ? (
            <ul
              aria-label={gt("Finished workers")}
              className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0"
            >
              <WorkerRows status="done" workers={done} onOpen={props.onOpen} />
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A Bot's page panel: its instructions and notes, then its workers. */
export function BotBoardPanel(
  props: Pick<ComponentProps<typeof ThreadDetailsCard>, "anchor" | "handle"> & {
    threadRef: ScopedThreadRef;
  },
) {
  const gt = useGT();
  const navigate = useNavigate();
  const board = useBotBoard(props.threadRef);
  const open = (threadRef: ScopedThreadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  const workerCount = board.needsYou.length + board.working.length + board.done.length;
  return (
    <ThreadDetailsCard
      threadRef={props.threadRef}
      anchor={props.anchor}
      handle={props.handle}
      contentKey="bot-board"
    >
      {() => (
        <>
          <ThreadDetailsSection headingId="bot-board-notes" title={gt("Instructions & notes")}>
            <BotNotes threadRef={props.threadRef} />
          </ThreadDetailsSection>
          {workerCount === 0 ? null : (
            <ThreadDetailsSection headingId="bot-board-workers" title={gt("Workers")}>
              <BotWorkers board={board} onOpen={open} />
            </ThreadDetailsSection>
          )}
        </>
      )}
    </ThreadDetailsCard>
  );
}
