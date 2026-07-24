import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { FolderPlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { filterDraftHeroProjects, isImeCommitKey } from "./draftHeroProjectSearch";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const [isProjectPickerOpen, setIsProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const filteredProjectEntries = useMemo(
    () =>
      filterDraftHeroProjects(
        projectPickerEntries.map((entry) => ({
          entry,
          title: entry.group.displayName,
          workspaceRoot: entry.targetProject.workspaceRoot,
          searchTerms: entry.group.memberProjects.flatMap((project) => [
            project.title,
            project.workspaceRoot,
          ]),
        })),
        projectQuery,
      ).map(({ entry }) => entry),
    [projectPickerEntries, projectQuery],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;

  const projectSelector = shouldShowProjectMenu ? (
    <Combobox
      autoHighlight
      items={projectPickerEntries.map(({ group }) => group.projectKey)}
      filteredItems={filteredProjectEntries.map(({ group }) => group.projectKey)}
      open={isProjectPickerOpen}
      value={activeProjectKey}
      onOpenChange={(open) => {
        setIsProjectPickerOpen(open);
        if (!open) {
          setProjectQuery("");
        }
      }}
      onValueChange={(value) => {
        if (!value || value === activeProjectKey) {
          setIsProjectPickerOpen(false);
          return;
        }
        const entry = projectEntryByKey.get(value);
        if (!entry) {
          return;
        }
        setIsProjectPickerOpen(false);
        const project = entry.targetProject;
        void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
          replace: true,
        });
      }}
    >
      <ComboboxTrigger
        aria-label={hasResolvedProject ? "Change project" : "Choose a project"}
        className="pointer-events-auto inline cursor-pointer border-current border-b border-dotted text-foreground underline-offset-8 transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {activeProjectDisplayName ?? "Choose a project"}
      </ComboboxTrigger>
      <ComboboxPopup align="center" className="w-72 max-w-[calc(100vw-1rem)]">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 text-muted-foreground/55"
            />
            <ComboboxInput
              autoFocus
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder="Search projects..."
              showTrigger={false}
              size="sm"
              unstyled
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
              onKeyDownCapture={(event) => {
                if (
                  isImeCommitKey({
                    key: event.key,
                    isComposing: event.nativeEvent.isComposing,
                    keyCode: event.nativeEvent.keyCode,
                  })
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
            />
          </div>
        </div>
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {filteredProjectEntries.map(({ group }) => {
            return (
              <ComboboxItem key={group.projectKey} value={group.projectKey}>
                <span className="min-w-0 truncate">{group.displayName}</span>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
        <div className="border-t border-border/70 p-1">
          <button
            type="button"
            className="flex min-h-8 w-full cursor-default items-center gap-2 rounded-sm px-2 py-1 text-left text-base text-foreground outline-none hover:bg-accent focus-visible:bg-accent sm:min-h-7 sm:text-sm"
            onClick={() => {
              setIsProjectPickerOpen(false);
              openAddProject();
            }}
          >
            <FolderPlusIcon />
            New project
          </button>
        </div>
      </ComboboxPopup>
    </Combobox>
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
