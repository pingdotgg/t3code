import { workspaceAreaProps } from "../lib/workspaceFocus";
import { T, useGT } from "gt-react";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const gt = useGT();
  const contentArea = workspaceAreaProps("home", 1, gt("Home"));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, scratchBlocked, startScratchThreadOrExplain } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  const scratchBlockedByRepository =
    scratchTargetEnvironmentId === null ? scratchBlocked(primaryEnvironmentId) : null;
  const offersScratch = scratchTargetEnvironmentId !== null || scratchBlockedByRepository !== null;

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>
                <T>What should we work on?</T>
              </EmptyTitle>
              <EmptyDescription>
                {offersScratch
                  ? gt("Add a project, or start without one.")
                  : gt("Add a project to start your first thread.")}
              </EmptyDescription>
              <div className="mt-6 flex justify-center gap-2">
                <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
                  <PlusIcon className="size-4" />
                  <T>Add project</T>
                </Button>
                {offersScratch ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void startScratchThreadOrExplain(
                        scratchTargetEnvironmentId,
                        scratchBlockedByRepository,
                      )
                    }
                  >
                    <MessageSquareDashedIcon className="size-4" />
                    <T>Start without a project</T>
                  </Button>
                ) : null}
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
