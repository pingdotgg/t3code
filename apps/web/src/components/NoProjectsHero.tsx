import { workspaceAreaProps } from "../lib/workspaceFocus";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useT } from "../hooks/useI18n";
import { useScratchProject } from "../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const t = useT();
  const contentArea = workspaceAreaProps("home", 1, t("app.noProjects.home"));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);

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
              <EmptyTitle>{t("app.noProjects.title")}</EmptyTitle>
              <EmptyDescription>
                {scratchTargetEnvironmentId === null
                  ? t("app.noProjects.addToStart")
                  : t("app.noProjects.addOrSkip")}
              </EmptyDescription>
              <div className="mt-6 flex justify-center gap-2">
                <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
                  <PlusIcon className="size-4" />
                  {t("app.noProjects.addProject")}
                </Button>
                {scratchTargetEnvironmentId === null ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                  >
                    <MessageSquareDashedIcon className="size-4" />
                    {t("app.noProjects.startWithout")}
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
