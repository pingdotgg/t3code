import { useNavigate } from "@tanstack/react-router";
import { ImportIcon, PlusIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

export function NoProjectsHero() {
  const navigate = useNavigate();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const openWelcome = useCallback(() => {
    void navigate({ to: "/welcome" });
  }, [navigate]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Add a project to start your first thread.
              </EmptyDescription>
              <div className="mt-6 flex flex-col items-center gap-2">
                <Button size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
                <Button size="sm" variant="ghost-muted" onClick={openWelcome}>
                  <ImportIcon className="size-4" />
                  Import from Claude Code or Codex
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
