import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon, XIcon } from "lucide-react";
import type { RefObject } from "react";

import { useProject, useThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { threadReferenceHighlight, usePinnedThreadReferences } from "~/threadReferenceHighlight";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function ReferenceHighlightChip(props: {
  threadRef: ScopedThreadRef;
  searchInputRef: RefObject<HTMLInputElement | null>;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { isMobile, setOpenMobile } = useSidebar();
  const shell = useThreadShell(props.threadRef);
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
  // Older settled threads are left out of the shell but still have a title on the server.
  const titles = useEnvironmentQuery(
    shell
      ? null
      : orchestrationEnvironment.threadTitles({
          environmentId,
          input: { threadIds: [threadId] },
        }),
  );
  const title =
    shell?.title.trim() ||
    titles.data?.[threadId] ||
    (shell || titles.isPending ? "Untitled thread" : "Thread no longer available");
  return (
    <ContextChip kind="thread" className="rounded-sm bg-(--context-chip-accent)/12 px-1.5 py-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId }}
              aria-label={`Open ${title}`}
              className="flex min-w-0 items-center gap-[0.2em] rounded-sm no-underline focus-visible:outline-2 focus-visible:outline-current"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
            />
          }
        >
          {project ? (
            <ProjectFavicon project={project} className="size-[1em] self-center" />
          ) : (
            <MessagesSquareIcon />
          )}
          <ContextChipLabel>{title}</ContextChipLabel>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{title}</TooltipPopup>
      </Tooltip>
      <ContextChipAction
        aria-label={`Remove ${title} highlight`}
        // The chip is small; a coarse pointer needs more than its 12px to land on it.
        className="relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
        onClick={(event) => {
          threadReferenceHighlight.unpin(props.threadRef);
          // A keyboard click removes the focused button; keep focus in the sidebar.
          if (event.detail === 0) props.searchInputRef.current?.focus();
        }}
      >
        <XIcon aria-hidden="true" />
      </ContextChipAction>
    </ContextChip>
  );
}

/** The thread references being highlighted, shown below the search input. */
export function SidebarReferenceHighlightBar(props: {
  searchInputRef: RefObject<HTMLInputElement | null>;
}) {
  const pinned = usePinnedThreadReferences();
  if (pinned.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Highlighted thread references"
      className="mt-1 flex max-h-24 flex-wrap items-center gap-1 overflow-y-auto px-1 text-xs"
    >
      {pinned.map((threadRef) => (
        <ReferenceHighlightChip
          key={scopedThreadKey(threadRef)}
          threadRef={threadRef}
          searchInputRef={props.searchInputRef}
        />
      ))}
      {pinned.length > 1 ? (
        <Button
          type="button"
          size="micro"
          variant="ghost-muted"
          aria-label="Clear all thread reference highlights"
          onClick={(event) => {
            threadReferenceHighlight.clear();
            if (event.detail === 0) props.searchInputRef.current?.focus();
          }}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
