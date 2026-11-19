import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { DownloadIcon, FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { shortcutLabelForCommand } from "../keybindings";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";
import { DraftProjectGroupLabel, DraftProjectRow } from "./chat/DraftHeroHeadline";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/**
 * The new-thread screen before any project exists (pen hsasH): the draft
 * hero's place list with nothing in it but the ways to get a project.
 */
export function NoProjectsHero() {
  const gt = useGT();
  const navigate = useNavigate();
  const contentArea = workspaceAreaProps("home", 1, gt("Home"));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openAddProject = () => openCommandPalette({ open: "add-project" });

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="scrollbar-gutter-both flex min-h-0 flex-1 items-center overflow-y-auto px-4 py-4">
          <div className="mx-auto flex w-full max-w-110 flex-col">
            <h1 className="sr-only">
              <T>Add a project to start</T>
            </h1>
            <div role="list" aria-label={gt("Projects")} className="flex flex-col gap-0.5">
              <DraftProjectGroupLabel>{gt("No projects yet")}</DraftProjectGroupLabel>
              <DraftProjectRow
                icon={<FolderPlusIcon className="size-4 shrink-0 text-foreground" />}
                label={gt("Add project…")}
                detail={gt("Open a folder or clone a repository")}
                onSelect={openAddProject}
              />
              <DraftProjectRow
                icon={<DownloadIcon className="size-4 shrink-0 text-foreground" />}
                label={gt("Import conversations…")}
                detail={gt("Continue from {claude}, {codex} or {pi}", {
                  claude: "Claude Code",
                  codex: "Codex",
                  pi: "Pi",
                })}
                onSelect={() => void navigate({ to: "/welcome" })}
              />
              {scratchTargetEnvironmentId === null ? null : (
                <>
                  <div aria-hidden className="mx-2.5 my-1 h-px bg-border" />
                  <DraftProjectRow
                    icon={
                      <MessageSquareDashedIcon className="size-4 shrink-0 text-muted-foreground" />
                    }
                    label={gt("No project")}
                    detail={gt("Its own folder, no git")}
                    shortcut={shortcutLabelForCommand(keybindings, "chat.newWithoutProject")}
                    onSelect={() => void startScratchThread(scratchTargetEnvironmentId)}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
