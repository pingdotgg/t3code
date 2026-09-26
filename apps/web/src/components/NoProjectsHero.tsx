import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>What should we work on?</EmptyTitle>
              <EmptyDescription>
                {scratchTargetEnvironmentId === null
                  ? "Add a project to start your first thread."
                  : "Add a project, or start in Scratch without one."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center gap-2">
                <Button size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
                {scratchTargetEnvironmentId === null ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                  >
                    <MessageSquareDashedIcon className="size-4" />
                    Start in Scratch
                  </Button>
                )}
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
