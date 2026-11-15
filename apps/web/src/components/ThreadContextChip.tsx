import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { followLayoutCompanions } from "~/layout/openRules";
import { useLayoutStore } from "~/layout/layoutStore";
import { useProject, useThreadShell } from "~/state/entities";
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
  const icon = project ? (
    <ProjectFavicon project={project} className="size-[1em] self-center" />
  ) : (
    <MessagesSquareIcon />
  );
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
                draggable={false}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  followLayoutCompanions(() =>
                    useLayoutStore.getState().focusChat({
                      kind: "server",
                      threadRef: scopeThreadRef(environmentId, threadId),
                    }),
                  );
                }}
              />
            }
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            {icon}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {props.unreadable
          ? "On another machine, so this machine's agent can't read it. Remove it or switch back to send."
          : "Open thread"}
      </TooltipPopup>
    </Tooltip>
  );
}
