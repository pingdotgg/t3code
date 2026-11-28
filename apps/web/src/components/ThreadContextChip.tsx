import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord, ProjectId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useGT } from "gt-react";

import { resolveThreadOpenRoute } from "~/lib/sideChatPane";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useProject, useLinkedThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadChipHoverCard } from "./ThreadChipHoverCard";
import { ThreadHoverCardPopup } from "./ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  projectId?: ProjectId | null;
  copyMarkdown?: string;
  unreadable?: boolean;
}) {
  const gt = useGT();
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
  const navigate = useNavigate();
  const settled = shell?.settledOverride === "settled";
  const settledLabel = settled ? gt("Settled", { $context: "thread status" }) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId }}
                onClick={(event) => {
                  if (shell?.lineage.sideChat !== true || event.button !== 0) return;
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  // A side chat opens as a tab beside its parent, not as its own page.
                  event.preventDefault();
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(
                      resolveThreadOpenRoute({ environmentId, threadId }, shell),
                    ),
                  });
                }}
                draggable={false}
              />
            }
            aria-label={gt("Thread, {title}", {
              title: settledLabel ? `${title}, ${settledLabel}` : title,
            })}
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
                {settledLabel}
              </span>
            ) : null}
          </ContextChip>
        }
      />
      <ThreadHoverCardPopup side="top">
        <ThreadChipHoverCard
          title={title}
          project={project}
          shell={shell}
          unreadable={props.unreadable === true}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
