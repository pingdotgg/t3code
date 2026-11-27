import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ThreadDetailsCard } from "../chat/ThreadDetailsCard";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuItemLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { BotNotes } from "./BotNotes";
import { useBotBoard } from "./useBotBoard";

const STATUS_DOT = {
  needsYou: "bg-warning",
  working: "bg-info",
  done: "bg-muted-foreground/40",
} as const;

function WorkerItem(props: {
  thread: EnvironmentThreadShell;
  status: keyof typeof STATUS_DOT;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const project = useProject(scopeProjectRef(props.thread.environmentId, props.thread.projectId));
  const projectName = project?.isScratch ? gt("No project") : (project?.title ?? null);
  return (
    <MenuItem
      onClick={() => props.onOpen(scopeThreadRef(props.thread.environmentId, props.thread.id))}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[props.status])}
      />
      <MenuItemLabel>{props.thread.title}</MenuItemLabel>
      {projectName === null ? null : <MenuItemDetail>{projectName}</MenuItemDetail>}
    </MenuItem>
  );
}

function WorkerGroup(props: {
  title: string;
  status: keyof typeof STATUS_DOT;
  workers: ReadonlyArray<EnvironmentThreadShell>;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  if (props.workers.length === 0) return null;
  return (
    <MenuGroup>
      <MenuGroupLabel>{props.title}</MenuGroupLabel>
      {props.workers.map((thread) => (
        <WorkerItem key={thread.id} thread={thread} status={props.status} onOpen={props.onOpen} />
      ))}
    </MenuGroup>
  );
}

/** A Bot's page panel: its instructions and notes, with its workers one menu away. */
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
            <ThreadDetailsSection
              headingId="bot-board-workers"
              title={gt("Workers")}
              showHeading={false}
            >
              <Menu>
                <MenuTrigger render={<Button variant="ghost-muted" size="compact" />}>
                  {gt("Workers · {count}", { count: workerCount })}
                  {board.needsYou.length > 0 ? (
                    <Badge variant="warning" size="sm">
                      <span aria-hidden>{board.needsYou.length}</span>
                      <span className="sr-only">
                        {gt("{count, plural, one {{count} needs you} other {{count} need you}}", {
                          count: board.needsYou.length,
                        })}
                      </span>
                    </Badge>
                  ) : null}
                  <ChevronDownIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="start" side="top" className="w-72">
                  <WorkerGroup
                    title={gt("Needs you")}
                    status="needsYou"
                    workers={board.needsYou}
                    onOpen={open}
                  />
                  <WorkerGroup
                    title={gt("Working")}
                    status="working"
                    workers={board.working}
                    onOpen={open}
                  />
                  <WorkerGroup
                    title={gt("Done")}
                    status="done"
                    workers={board.done}
                    onOpen={open}
                  />
                </MenuPopup>
              </Menu>
            </ThreadDetailsSection>
          )}
        </>
      )}
    </ThreadDetailsCard>
  );
}
