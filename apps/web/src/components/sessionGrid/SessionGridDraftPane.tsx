import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import type { DraftId, DraftSessionState } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import { useThread } from "../../state/entities";
import ChatView from "../ChatView";
import { threadHasStarted } from "../ChatView.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";

interface SessionGridDraftPaneProps {
  readonly draftId: DraftId;
  readonly draft: DraftSessionState;
  readonly project: EnvironmentProject;
  readonly environmentLabel: string | null;
  readonly focused: boolean;
  readonly panelControlsPortalTarget: HTMLElement | null;
  readonly rightPanelPortalTarget: HTMLElement | null;
  readonly onFocus: (itemKey: string) => void;
  readonly onDiscard: (draftId: DraftId) => void;
  readonly onPromoted: (threadRef: ScopedThreadRef) => void;
}

// fork: project session grid — an unsubmitted thread is a first-class grid
// pane, using the same draft ChatView and composer as the full workspace.
export const SessionGridDraftPane = memo(function SessionGridDraftPane(
  props: SessionGridDraftPaneProps,
) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.draft.environmentId, props.draft.threadId),
    [props.draft.environmentId, props.draft.threadId],
  );
  const serverThread = useThread(threadRef);
  const itemKey = `draft:${props.draftId}`;
  const [runContextPortalTarget, setRunContextPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (threadHasStarted(serverThread)) {
      props.onPromoted(threadRef);
    }
  }, [props.onPromoted, serverThread, threadRef]);

  const header = (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-ring/10 text-ring">
        <PlusIcon className="size-2.5" />
      </span>
      <ProjectFavicon
        className="size-3.5 shrink-0"
        cwd={props.project.workspaceRoot}
        environmentId={props.draft.environmentId}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold leading-4 text-foreground">New session</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-muted-foreground/70">
          <span>Draft</span>
          {props.environmentLabel ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{props.environmentLabel}</span>
            </>
          ) : null}
        </div>
      </div>
      <div
        ref={setRunContextPortalTarget}
        className="flex min-w-0 w-fit max-w-[42%] shrink-0 items-center justify-end"
      />
      <Button
        aria-label="Discard new session"
        onClick={() => props.onDiscard(props.draftId)}
        size="icon-xs"
        title="Discard draft"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );

  return (
    <section
      aria-label="New session draft"
      className={cn(
        "group/session-pane relative flex min-h-0 min-w-0 overflow-hidden rounded-xl border border-dashed bg-background shadow-sm/5 outline-none",
        "ring-offset-2 ring-offset-zinc-900 focus-visible:ring-2 focus-visible:ring-ring/60 dark:ring-offset-black",
        props.focused && "border-solid border-foreground/20 shadow-sm/10",
      )}
      data-session-grid-pane
      onFocusCapture={() => props.onFocus(itemKey)}
      onPointerDownCapture={() => props.onFocus(itemKey)}
      tabIndex={0}
    >
      {props.focused ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 left-0 z-10 h-7 w-0.5 rounded-r-full bg-ring/65"
        />
      ) : null}
      <ChatView
        draftId={props.draftId}
        environmentId={props.draft.environmentId}
        gridHeader={header}
        gridRunContextPortalTarget={runContextPortalTarget}
        isActiveSurface={props.focused}
        panelControlsPortalTarget={props.panelControlsPortalTarget}
        reserveTitleBarControlInset={false}
        rightPanelPortalTarget={props.rightPanelPortalTarget}
        routeKind="draft"
        surfaceMode="grid-pane"
        threadId={props.draft.threadId}
      />
    </section>
  );
});
