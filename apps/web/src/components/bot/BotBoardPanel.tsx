import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ThreadDetailsCard } from "../chat/ThreadDetailsCard";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { BotNotes } from "./BotNotes";
import { useBotBoard } from "./useBotBoard";

const STATUS_DOT = {
  needsYou: "bg-warning",
  working: "bg-info",
  done: "bg-muted-foreground/40",
} as const;

function CrewRow(props: {
  thread: EnvironmentThreadShell;
  status: keyof typeof STATUS_DOT;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const project = useProject(scopeProjectRef(props.thread.environmentId, props.thread.projectId));
  const projectName = project?.isScratch ? gt("No project") : (project?.title ?? null);
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onOpen(scopeThreadRef(props.thread.environmentId, props.thread.id))}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[props.status])}
        />
        <span className="min-w-0 flex-1 truncate text-foreground">{props.thread.title}</span>
        {projectName === null ? null : (
          <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">{projectName}</span>
        )}
      </button>
    </li>
  );
}

function CrewSection(props: {
  id: string;
  title: string;
  status: keyof typeof STATUS_DOT;
  crew: ReadonlyArray<EnvironmentThreadShell>;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  if (props.crew.length === 0) return null;
  return (
    <ThreadDetailsSection headingId={`bot-board-${props.id}`} title={props.title}>
      <ul className="flex flex-col">
        {props.crew.map((thread) => (
          <CrewRow key={thread.id} thread={thread} status={props.status} onOpen={props.onOpen} />
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}

/** A Bot's page panel: its crew by what they need, then its instructions and notes. */
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
  const hasCrew = board.needsYou.length + board.working.length + board.done.length > 0;
  return (
    <ThreadDetailsCard
      threadRef={props.threadRef}
      anchor={props.anchor}
      handle={props.handle}
      contentKey="bot-board"
    >
      {() => (
        <>
          <CrewSection
            id="needs-you"
            title={gt("Needs you")}
            status="needsYou"
            crew={board.needsYou}
            onOpen={open}
          />
          <CrewSection
            id="working"
            title={gt("Working")}
            status="working"
            crew={board.working}
            onOpen={open}
          />
          <CrewSection id="done" title={gt("Done")} status="done" crew={board.done} onOpen={open} />
          {hasCrew ? null : (
            <p className="px-4.5 pt-4 pb-1 text-muted-foreground text-xs">
              <T>No crew yet. Threads this Bot starts show here.</T>
            </p>
          )}
          <ThreadDetailsSection headingId="bot-board-notes" title={gt("Instructions & notes")}>
            <BotNotes threadRef={props.threadRef} />
          </ThreadDetailsSection>
        </>
      )}
    </ThreadDetailsCard>
  );
}
