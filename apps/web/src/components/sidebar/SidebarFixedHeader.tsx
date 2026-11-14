import type { useSidebarState } from "./useSidebarState";

import { Button } from "../ui/button";
import { Combobox, ComboboxEmpty, ComboboxSearchInput, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxTrigger } from "../ui/combobox";

import { CheckIcon, FolderIcon, ListFilterIcon, SettingsIcon } from "lucide-react";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { SidebarGroup } from "../ui/sidebar";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./SidebarThreadHeader";
import { shortcutLabelForCommand } from "../../keybindings";
import { shouldCreateNewThreadInCurrentProject } from "../Sidebar.logic";
import { type ReactNode } from "react";

function ProjectScopeRowIcon(props: { isSelected: boolean; children: ReactNode }) {
  return (
    <span className="relative flex shrink-0">
      {props.children}
      {props.isSelected ? (
        <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-popover">
          <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
        </span>
      ) : null}
    </span>
  );
}
export function SidebarFixedHeader(props: ReturnType<typeof useSidebarState>) {
  const { activeSearchResultIndex, canPinProject, clearThreadSearch, dispatchProjectScopeMenu, environmentMachineById, filteredProjectScopeItems, handleNewThreadClick, handleProjectSettings, handleThreadSearchKeyDown, highlightedProjectScopeKeyRef, isSearchingThreads, keybindings, legacySidebarEnabled, newThreadInProjectShortcutLabel, newThreadShortcutLabel, openAddProjectCommandPalette, primaryEnvironmentId, projectGroupByScopeKey, projectGroups, projectScopeItems, projectScopeKeys, projectScopeMenuState, projects, scopeGroups, scopedProjectGroups, selectedProjectScopeItem, setProjectScopeKeys, setSearchHighlightKey, setThreadSearchQuery, showProjectEnvironments, suppressNextScopeChangeRef, threadSearchInputRef, threadSearchQuery, threadSearchResults, threads, toggleProjectGroupPin, toggleProjectScopeKey } = props;
  return (
            <SidebarGroup className="z-[1]">
              <SidebarThreadHeader
                hasProjects={projectGroups.length > 0}
                projectScope={
                  <Combobox
                    items={projectScopeItems}
                    filteredItems={filteredProjectScopeItems}
                    autoHighlight
                    itemToStringLabel={(item) => item.label}
                    isItemEqualToValue={(a, b) => a.value === b.value}
                    open={projectScopeMenuState.open}
                    onOpenChange={(open, eventDetails) => {
                      if (eventDetails.isCanceled) return;
                      if (open) suppressNextScopeChangeRef.current = false;
                      dispatchProjectScopeMenu({ type: "open-changed", open });
                    }}
                    onItemHighlighted={(item) => {
                      highlightedProjectScopeKeyRef.current = item?.value ?? null;
                    }}
                    value={selectedProjectScopeItem}
                    onValueChange={(item, eventDetails) => {
                      if (suppressNextScopeChangeRef.current) {
                        suppressNextScopeChangeRef.current = false;
                        return;
                      }
                      if (!item) return;
                      if (item.value === "all") {
                        setProjectScopeKeys([]);
                      } else if (
                        eventDetails.event instanceof MouseEvent &&
                        eventDetails.event.shiftKey
                      ) {
                        // Canceling skips Base UI's commit, which would freeze the search query, and its close.
                        eventDetails.cancel();
                        toggleProjectScopeKey(item.value);
                      } else {
                        setProjectScopeKeys([item.value]);
                      }
                    }}
                  >
                    <ComboboxTrigger
                      render={
                        <SidebarHeaderIconButton
                          label={
                            scopedProjectGroups.length > 0
                              ? `Filter threads by project: ${scopedProjectGroups.map((project) => project.displayName).join(", ")}`
                              : "Filter threads by project"
                          }
                        />
                      }
                    >
                      {scopedProjectGroups.length > 1 ? (
                        <span className="flex shrink-0 -space-x-1.5">
                          {scopedProjectGroups.slice(0, 2).map((project) => (
                            <ProjectFavicon
                              key={project.projectKey}
                              project={project}
                              className="size-3.5"
                            />
                          ))}
                        </span>
                      ) : scopedProjectGroups[0] ? (
                        <span className="flex shrink-0">
                          <ProjectFavicon project={scopedProjectGroups[0]} className="size-4" />
                        </span>
                      ) : (
                        <ListFilterIcon className="size-4" />
                      )}
                    </ComboboxTrigger>
                    {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
                    <ComboboxPopup
                      align="start"
                      collisionAvoidance={{ side: "flip", align: "shift" }}
                      className="w-[min(18rem,var(--available-width))] overflow-hidden"
                      finalFocus={(closeType) => closeType === "keyboard"}
                    >
                      <ComboboxSearchInput
                        aria-label="Search projects"
                        placeholder="Search projects..."
                        value={projectScopeMenuState.query}
                        onKeyDown={(event) => {
                          if (
                            event.defaultPrevented ||
                            event.nativeEvent.isComposing ||
                            event.keyCode === 229
                          ) {
                            return;
                          }
                          const scopeKey = highlightedProjectScopeKeyRef.current;
                          const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
                          // The thread pin shortcut pins the highlighted project here.
                          if (
                            project &&
                            canPinProject(project) &&
                            isProjectPinShortcut(event, keybindings)
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleProjectGroupPin(project);
                            return;
                          }
                          if (event.ctrlKey || event.altKey || event.metaKey) return;
                          if (event.shiftKey && event.key === "Enter") {
                            if (!project) return;
                            event.preventDefault();
                            toggleProjectScopeKey(project.projectKey);
                            return;
                          }
                          if (
                            event.key !== "ContextMenu" &&
                            !(event.shiftKey && event.key === "F10")
                          ) {
                            return;
                          }
                          if (project) handleProjectSettings(event, project);
                        }}
                        onChange={(event) =>
                          dispatchProjectScopeMenu({
                            type: "query-changed",
                            query: event.target.value,
                          })
                        }
                      />
                      <ComboboxEmpty>No matching projects.</ComboboxEmpty>
                      <ComboboxList aria-multiselectable>
                        {(item: (typeof projectScopeItems)[number]) => {
                          const project = projectGroupByScopeKey.get(item.value) ?? null;
                          const isSelected = project
                            ? projectScopeKeys.includes(item.value)
                            : projectScopeKeys.length === 0;
                          return (
                            <ComboboxItem
                              key={item.value}
                              hideIndicator
                              value={item}
                              aria-selected={isSelected}
                              // The icon badge marks selection; Base UI's single value would shade one row.
                              data-selected={undefined}
                              onContextMenu={(event) => {
                                if (project) handleProjectSettings(event, project);
                              }}
                            >
                              <ProjectScopeRowIcon isSelected={isSelected}>
                                {project ? (
                                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                                ) : (
                                  <FolderIcon className="size-4 shrink-0" />
                                )}
                              </ProjectScopeRowIcon>
                              <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                              {project && canPinProject(project) ? (
                                <ProjectPinButton
                                  name={project.displayName}
                                  pinned={project.pinned}
                                  shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                                  onToggle={() => toggleProjectGroupPin(project)}
                                />
                              ) : null}
                              {project && showProjectEnvironments ? (
                                <ProjectEnvironmentBadge
                                  group={project}
                                  primaryEnvironmentId={primaryEnvironmentId}
                                  machineByEnvironmentId={environmentMachineById}
                                />
                              ) : null}
                              {project ? (
                                <Button
                                  size="icon-xs"
                                  variant="ghost-muted"
                                  tabIndex={-1}
                                  aria-hidden="true"
                                  title={`Project settings for ${project.displayName}`}
                                  className={canPinProject(project) ? undefined : "ml-auto"}
                                  onPointerDown={(event) => event.stopPropagation()}
                                  onClick={(event) => {
                                    void handleProjectSettings(event, project);
                                  }}
                                >
                                  <SettingsIcon className="size-3.5" />
                                </Button>
                              ) : null}
                            </ComboboxItem>
                          );
                        }}
                      </ComboboxList>
                    </ComboboxPopup>
                  </Combobox>
                }
                onNewProject={openAddProjectCommandPalette}
                onNewThread={handleNewThreadClick}
                newThreadDisabled={projects.length === 0}
                newThreadShortcutLabel={newThreadShortcutLabel}
                newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
                showNewThreadInProjectHint={
                  !legacySidebarEnabled &&
                  !shouldCreateNewThreadInCurrentProject(
                    false,
                    scopeGroups.length,
                    projectGroups.length,
                  )
                }
                searchInputRef={threadSearchInputRef}
                searchQuery={threadSearchQuery}
                onSearchQueryChange={(value) => {
                  setThreadSearchQuery(value);
                  setSearchHighlightKey(null);
                }}
                onSearchKeyDown={handleThreadSearchKeyDown}
                isSearching={isSearchingThreads}
                searchResultCount={threadSearchResults.length}
                activeSearchResultIndex={activeSearchResultIndex}
                onClearSearch={clearThreadSearch}
              />
            </SidebarGroup>
  );
}
