import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { memo } from "react";
import { readLocalApi } from "~/localApi";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ChatHeaderProps {
  activeThreadTitle: string;
  activeProject: EnvironmentProject | null;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadTitle,
  activeProject,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
}: ChatHeaderProps) {
  return (
    <div
      onContextMenu={
        onOpenProjectSettings === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              const api = readLocalApi();
              if (!api) return;
              void api.contextMenu
                .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
                  x: event.clientX,
                  y: event.clientY,
                })
                .then((action) => {
                  if (action === "project-settings") onOpenProjectSettings();
                });
            }
      }
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProject ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`New thread in ${activeProject.title}`}
                    onClick={onNewThreadInProject}
                    className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <ProjectFavicon project={activeProject} className="size-3.5" />
                <span className="max-w-40 truncate text-sm font-medium">{activeProject.title}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">New thread in {activeProject.title}</TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
