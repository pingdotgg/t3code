import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { FolderPlusIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useOpenAddProjectCommandPalette } from "~/commandPaletteContext";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useProjects, useThreadShells } from "~/state/entities";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import {
  getIncrementalTextCompletionStart,
  INCREMENTAL_TEXT_COMPLETION_INTERVAL_MS,
  splitTextForIncrementalCompletion,
} from "./incrementalTextCompletion";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

function useIncrementalProjectTitle(
  projectKey: string,
  projectTitle: string | null,
): string | null {
  const [completedTitle, setCompletedTitle] = useState(projectTitle);
  const completedTitleRef = useRef(projectTitle);
  const previousProjectKeyRef = useRef(projectKey);

  useLayoutEffect(() => {
    const projectChanged = previousProjectKeyRef.current !== projectKey;
    previousProjectKeyRef.current = projectKey;

    if (!projectChanged || projectTitle === null) {
      completedTitleRef.current = projectTitle;
      setCompletedTitle(projectTitle);
      return;
    }

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    if (prefersReducedMotion) {
      completedTitleRef.current = projectTitle;
      setCompletedTitle(projectTitle);
      return;
    }

    const characters = splitTextForIncrementalCompletion(projectTitle);
    let completedCharacterCount = getIncrementalTextCompletionStart(
      completedTitleRef.current ?? "",
      projectTitle,
    );
    const updateCompletedTitle = () => {
      const nextTitle = characters.slice(0, completedCharacterCount).join("");
      completedTitleRef.current = nextTitle;
      setCompletedTitle(nextTitle);
    };

    updateCompletedTitle();
    if (completedCharacterCount >= characters.length) {
      return;
    }

    const intervalId = window.setInterval(() => {
      completedCharacterCount += 1;
      updateCompletedTitle();
      if (completedCharacterCount >= characters.length) {
        window.clearInterval(intervalId);
      }
    }, INCREMENTAL_TEXT_COMPLETION_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [projectKey, projectTitle]);

  return completedTitle;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useOpenAddProjectCommandPalette();

  const orderedProjects = useMemo(
    () => sortScopedProjectsForSidebar(projects, threads, "updated_at"),
    [projects, threads],
  );
  const projectByKey = useMemo(
    () =>
      new Map(
        orderedProjects.map(
          (project) =>
            [
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
              project,
            ] as const,
        ),
      ),
    [orderedProjects],
  );
  const activeProjectKey = activeProjectRef === null ? "" : scopedProjectKey(activeProjectRef);
  const completedProjectTitle = useIncrementalProjectTitle(activeProjectKey, activeProjectTitle);
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = orderedProjects.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <MenuTrigger
        aria-label={hasResolvedProject ? "Change project" : "Choose a project"}
        className="pointer-events-auto inline cursor-pointer border-current border-b border-dotted text-foreground underline-offset-8 transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {activeProjectTitle ? (
          <span className="inline-grid">
            <span aria-hidden className="invisible col-start-1 row-start-1">
              {activeProjectTitle}
            </span>
            <span className="col-start-1 row-start-1">{completedProjectTitle}</span>
          </span>
        ) : (
          "Choose a project"
        )}
      </MenuTrigger>
      <MenuPopup align="center" className="max-h-80 w-64 overflow-y-auto">
        <MenuRadioGroup
          value={activeProjectKey}
          onValueChange={(value) => {
            const project = projectByKey.get(value as string);
            if (!project || value === activeProjectKey) {
              return;
            }
            void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
              replace: true,
            });
          }}
        >
          {orderedProjects.map((project) => {
            const key = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
            return (
              <MenuRadioItem key={key} value={key} closeOnClick>
                <span className="min-w-0 truncate">{project.title}</span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          New project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-current border-b border-dotted text-muted-foreground/60 underline-offset-8 transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {hasResolvedProject ? (
        <>What should we build in {projectSelector}?</>
      ) : canChooseProject ? (
        <>{projectSelector} to start</>
      ) : (
        <>Add a project to start</>
      )}
    </h1>
  );
}
