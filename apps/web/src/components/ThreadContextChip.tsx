import { threadReferenceHighlight, useReferenceHighlightRole } from "../threadReferenceHighlight";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect } from "react";

import { cn } from "~/lib/utils";
import { useProject, useThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const { enter, leave, pin } = threadReferenceHighlight;

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  copyMarkdown?: string;
  unreadable?: boolean;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  // A chip for a related thread stays plain: only mentions of the active reference stand out.
  const isTarget =
    useReferenceHighlightRole(scopedThreadKey({ environmentId, threadId })) === "target";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- no pointerleave fires for a chip that unmounts under the pointer, and the shared hover would stick
  useEffect(() => () => leave({ environmentId, threadId }), [environmentId, threadId]);
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
  const title = shell?.title?.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            onPointerEnter={() => enter({ environmentId, threadId })}
            onPointerLeave={(event) => {
              if (!event.currentTarget.matches(":focus-within")) leave({ environmentId, threadId });
            }}
            onFocus={() => enter({ environmentId, threadId })}
            onClick={() => pin({ environmentId, threadId })}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) leave({ environmentId, threadId });
            }}
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            data-reference-highlight={isTarget ? "target" : undefined}
            className={cn(
              "no-underline",
              isTarget && "bg-(--context-chip-ink)/15 ring-1 ring-(--context-chip-ink)",
            )}
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {props.unreadable
          ? "On another machine, so this machine's agent can't read it. Remove it or switch back to send."
          : shell
            ? "Open thread"
            : "Thread no longer available"}
      </TooltipPopup>
    </Tooltip>
  );
}
