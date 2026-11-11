import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { useProject, useLinkedThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  projectId?: ProjectId | null;
  copyMarkdown?: string;
  unreadable?: boolean;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useLinkedThreadShell({ environmentId, threadId });
  const lookup = useEnvironmentQuery(
    shell === null && props.projectId === undefined
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId,
          input: { threadIds: [threadId] },
        })
      : null,
  );
  const metadata = lookup.data?.[threadId];
  const projectId = shell?.projectId ?? props.projectId ?? metadata?.projectId;
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const title = shell?.title?.trim() || metadata?.title.trim() || props.record.title;
  const settled = shell?.settledOverride === "settled";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
            aria-label={`Thread, ${title}${settled ? ", settled" : ""}`}
            data-markdown-copy={props.copyMarkdown}
            className={
              settled ? "rounded-md bg-foreground/5 px-1.5 py-0.5 no-underline" : "no-underline"
            }
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
            {settled ? (
              <span className="ms-1 shrink-0 border-s border-foreground/15 ps-1.5 text-xs font-normal text-muted-foreground">
                Settled
              </span>
            ) : null}
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {props.unreadable
          ? "On another machine, so this machine's agent can't read it. Remove it or switch back to send."
          : settled
            ? "Open settled thread"
            : "Open thread"}
      </TooltipPopup>
    </Tooltip>
  );
}
