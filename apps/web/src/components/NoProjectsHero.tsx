import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useAtomValue } from "@effect/atom-react";
import {
  DownloadIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  PlusIcon,
  SquarePenIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { shortcutLabelForCommand } from "../keybindings";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";
import { DraftProjectGroupLabel, DraftProjectRow } from "./chat/DraftHeroHeadline";
import { NoProjectsComposer } from "./chat/NoProjectsComposer";
import { PanelLayoutControls } from "./chat/PanelLayoutControls";
import { ChatPaneHeaderControls } from "./chat/ChatPaneHeader";
import { PANE_TAB_CLASS, PaneNotch } from "./PaneNotch";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/**
 * The new-thread screen before any project exists (pen hsasH): the draft
 * hero's place list with nothing in it but the ways to get a project.
 */
export function NoProjectsHero() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, scratchUnavailableReason, startScratchThread } =
    useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  const scratchOffReason = scratchUnavailableReason(primaryEnvironmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openAddProject = () => openCommandPalette({ open: "add-project" });

  return (
    <NewThreadPane addDisabledReason="Add a project first">
      {/* Like a draft: the list centered above the composer docked at the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end pt-1.5 [container:draft-hero/size] sm:pt-2">
        <div className="chat-composer-lane scrollbar-gutter-both flex min-h-0 w-full flex-1 items-center overflow-y-auto py-4 [@container_draft-hero_(max-height:440px)]:hidden">
          <div className="mx-auto flex w-full max-w-110 flex-col">
            <h1 className="sr-only">Add a project to start</h1>
            <div role="list" aria-label="Projects" className="flex flex-col gap-0.5">
              <DraftProjectGroupLabel>No projects yet</DraftProjectGroupLabel>
              <DraftProjectRow
                icon={<FolderPlusIcon className="size-4 shrink-0 text-foreground" />}
                label="Add project…"
                detail="Open a folder or clone a repository"
                onSelect={openAddProject}
              />
              <DraftProjectRow
                icon={<DownloadIcon className="size-4 shrink-0 text-foreground" />}
                label="Import conversations…"
                detail="Continue from Claude Code, Codex or Pi"
                onSelect={() => void navigate({ to: "/welcome" })}
              />
              {scratchTargetEnvironmentId === null && scratchOffReason === null ? null : (
                <>
                  <div aria-hidden className="mx-2.5 my-1 h-px bg-border" />
                  <DraftProjectRow
                    icon={
                      <MessageSquareDashedIcon className="size-4 shrink-0 text-muted-foreground" />
                    }
                    label="No project"
                    detail={scratchOffReason ?? "Its own folder, no git"}
                    disabled={scratchTargetEnvironmentId === null}
                    shortcut={
                      scratchTargetEnvironmentId === null
                        ? null
                        : shortcutLabelForCommand(keybindings, "chat.newWithoutProject")
                    }
                    onSelect={() => {
                      if (scratchTargetEnvironmentId !== null) {
                        void startScratchThread(scratchTargetEnvironmentId);
                      }
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </div>
        {primaryEnvironmentId === null ? null : (
          <div className="chat-composer-lane w-full">
            <div className="mx-auto w-full max-w-(--chat-content-max-width)">
              <NoProjectsComposer
                environmentId={primaryEnvironmentId}
                onStartWithoutProject={
                  scratchTargetEnvironmentId === null
                    ? null
                    : () =>
                        void startScratchThread(scratchTargetEnvironmentId, {
                          sendCarriedDraft: true,
                        })
                }
                startUnavailableReason={scratchOffReason}
              />
              <div
                aria-hidden
                className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
              />
            </div>
          </div>
        )}
      </div>
    </NewThreadPane>
  );
}

/**
 * The pane a new draft opens in, with its one "New thread" tab in the notch.
 * Empty, it holds the place while the app loads its projects.
 */
function NewThreadPane({
  addDisabledReason,
  children,
}: {
  readonly addDisabledReason: string;
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Home")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The pane header a draft would have, with its one tab in the notch. */}
        <WorkspacePageHeader
          electron={isElectron}
          className="relative z-10 md:pl-0"
          data-pane-header=""
        >
          <div className="flex w-full min-w-0 items-center gap-3 self-stretch">
            <PaneNotch>
              <div className={PANE_TAB_CLASS}>
                <SquarePenIcon aria-hidden className="size-3.5 shrink-0" />
                New thread
              </div>
              {/* A draft's "+" and details toggle, with nothing to act on yet. */}
              <Tooltip>
                <TooltipTrigger render={<span data-pane-notch-add="" className="flex shrink-0" />}>
                  <Button variant="bare" size="icon-xs" disabled aria-label="New tab">
                    <PlusIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipPopup side="bottom">{addDisabledReason}</TooltipPopup>
              </Tooltip>
            </PaneNotch>
          </div>
          <ChatPaneHeaderControls>
            <PanelLayoutControls
              threadPanelOpen={false}
              threadPanelPresentation="inline"
              threadPanelShortcutLabel={null}
              onToggleThreadPanel={() => {}}
              disabledReason="No thread yet"
            />
          </ChatPaneHeaderControls>
        </WorkspacePageHeader>
        {children}
      </div>
    </SidebarInset>
  );
}
