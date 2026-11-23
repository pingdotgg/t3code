import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord, ProjectId } from "@t3tools/contracts";
import { isArchivedThreadLinkTarget } from "@t3tools/shared/threadLinks";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, MessagesSquareIcon } from "lucide-react";
import { useGT } from "gt-react";

import { resolveThreadOpenRoute } from "~/lib/sideChatPane";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useProject, useThreadShell } from "~/state/entities";
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
  /** From the caller's own metadata read; without it the chip reads it when the shell is not loaded. */
  archived?: boolean;
  copyMarkdown?: string;
  unreadable?: boolean;
}) {
  const gt = useGT();
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
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
  // An archived thread has no page of its own, so its link goes to the archive, where it can be unarchived.
  const archived = shell
    ? isArchivedThreadLinkTarget(shell)
    : (props.archived ?? isArchivedThreadLinkTarget(metadata));
  const navigate = useNavigate();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable
              ? { state: "invalid" as const }
              : archived
                ? { state: "unresolved" as const }
                : {})}
            render={
              archived ? (
                <Link to="/settings/archived" draggable={false} />
              ) : (
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
              )
            }
            aria-label={
              archived
                ? gt("Archived thread, {title}", { title })
                : gt("Thread, {title}", { title })
            }
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            {archived ? (
              <ArchiveIcon />
            ) : project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <ThreadHoverCardPopup side="top">
        <ThreadChipHoverCard
          title={title}
          project={project}
          shell={shell}
          unreadable={props.unreadable === true}
          archived={archived}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
