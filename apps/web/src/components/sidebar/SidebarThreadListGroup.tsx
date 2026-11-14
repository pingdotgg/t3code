import type { useSidebarState } from "./useSidebarState";

import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { DndContext } from "@dnd-kit/core";
import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type ReactNode } from "react";
import { SidebarDraftBlock } from "./SidebarDraftBlock";
import {
  SidebarDragBoundary,
  SidebarSectionHeader,
  SidebarSectionPlaceholder,
} from "./SidebarListMarkers";
import { SidebarGroup } from "../ui/sidebar";
import {
  SidebarProjectFolderHeader,
  sidebarFolderRowId,
} from "./SidebarProjectFolderHeader";
import { SidebarSearchResultRow, SortableThreadRow, type SidebarProviderEntry } from "./SidebarThreadRow";
import { resolveSidebarDropVerb, type SidebarSection } from "../Sidebar.logic";
import { SortableContext } from "@dnd-kit/sortable";
import { TooltipProvider } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { snoozeWakeLabel } from "../Sidebar.snooze";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();

export const SETTLED_TAIL_PAGE_COUNT = 25;

const threadSearchResultId = (index: number) => `sidebar-thread-search-result-${index}`;
export function SidebarThreadListGroup(props: ReturnType<typeof useSidebarState>) {
  const { acknowledgeWoke, actionSweep, activeSearchResultIndex, activeThreads, attachTreeRef, attemptSettle, attemptSnooze, attemptUnpin, attemptUnsettle, attemptUnsnooze, cancelThreadRename, commitThreadRename, dndCollisionDetection, dndModifiers, dndSensors, dragState, dragTargetSection, draggableThreadKeys, environmentLabelById, environmentMachineById, folderRowsMultiline, handleDraftContextMenu, handleProjectFolderContextMenu, handleThreadClick, handleThreadContextMenu, handleThreadDragEnd, handleThreadDragOver, handleThreadDragStart, handleThreadFileDrop, hasProjectFolders, hiddenSettledCount, isContextDrag, isSearchingThreads, jumpLabelByKey, navigateToDraft, navigateToThread, olderSettledShelf, openAddProjectCommandPalette, optimisticDrop, pinnedThreads, primaryEnvironmentId, projectByKey, projectDisplayNameByKey, projectFolders, projects, providerEntriesByEnvironment, renamingThreadKey, renamingTitle, renderedSettledThreads, revealActiveRow, routeDraftIdForRows, routeRowThreadKey, routeThreadKey, routeThreadRef, scopedProjectGroups, scopedProjectKeys, scratchMachineLabelFor, selectThreadSearchResult, serverConfigs, setActiveSearchResultIndex, setRenamingTitle, settledCount, settledShelfExpanded, settledThreadKeys, showJumpHints, showMoreSettled, sidebarListItems, sidebarSortingStrategy, snoozeNow, snoozedShelfExpanded, snoozedThreads, sortableIds, startActionSweep, startThreadInProjectFolder, startThreadRename, threadByKey, threadSearch, threadSearchMatchByKey, threadSearchQuery, threadSearchResults, threads, timestampFormat, toggleProjectFolder, toggleSettledShelf, toggleSnoozedShelf, toggleWorkingShelf, visibleDraftSessionCount, workingShelfExpanded, workingThreads } = props;
  return (
          <SidebarGroup className="flex-1" role="presentation">
            {isSearchingThreads ? (
              threadSearchResults.length > 0 ? (
                <TooltipProvider
                  key="sidebar-thread-search-tooltips-150"
                  delay={150}
                  closeDelay={0}
                  timeout={400}
                >
                  <ul
                    id="sidebar-thread-search-results"
                    role="listbox"
                    aria-label="Thread search results"
                    className="flex flex-col gap-px"
                  >
                    {threadSearchResults.map((thread, index) => {
                      const threadKey = scopedThreadKey(
                        scopeThreadRef(thread.environmentId, thread.id),
                      );
                      return (
                        <SidebarSearchResultRow
                          isSettled={settledThreadKeys.has(threadKey)}
                          key={threadKey}
                          thread={thread}
                          project={
                            projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                          }
                          projectDisplayName={
                            projectDisplayNameByKey.get(
                              `${thread.environmentId}:${thread.projectId}`,
                            ) ?? null
                          }
                          environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                          environmentMachine={
                            environmentMachineById.get(thread.environmentId) ?? "server"
                          }
                          providerEntryByInstanceId={
                            providerEntriesByEnvironment.get(thread.environmentId) ??
                            EMPTY_PROVIDER_ENTRIES
                          }
                          isHighlighted={activeSearchResultIndex === index}
                          isRouteActive={routeRowThreadKey === threadKey}
                          resultId={threadSearchResultId(index)}
                          searchMatch={
                            threadSearchMatchByKey.get(
                              threadSearchMatchKey({
                                environmentId: thread.environmentId,
                                threadId: thread.id,
                              }),
                            ) ?? null
                          }
                          searchQuery={threadSearchQuery}
                          searchMatchQuery={threadSearch.query}
                          onHighlight={() => setActiveSearchResultIndex(index)}
                          onSelect={() => selectThreadSearchResult(thread)}
                          onFileDropThreads={handleThreadFileDrop}
                        />
                      );
                    })}
                  </ul>
                </TooltipProvider>
              ) : (
                <p
                  role="status"
                  className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
                >
                  {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
                </p>
              )
            ) : null}
            {!isSearchingThreads ? (
              <TooltipProvider
                key="sidebar-thread-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <DndContext
                  sensors={dndSensors}
                  autoScroll={!isContextDrag}
                  collisionDetection={dndCollisionDetection}
                  modifiers={dndModifiers}
                  onDragStart={handleThreadDragStart}
                  onDragOver={handleThreadDragOver}
                  onDragEnd={handleThreadDragEnd}
                >
                  <SortableContext items={sortableIds} strategy={sidebarSortingStrategy}>
                    <ul
                      ref={attachTreeRef}
                      // Presentation flattens VoiceOver's list interaction boundary while preserving descendant
                      // controls.
                      role="presentation"
                      className={cn(
                        "relative flex flex-col gap-px",
                        sidebarListItems.length > 0 && "flex-1",
                        actionSweep !== null && "**:pointer-events-none",
                      )}
                    >
                      {(() => {
                        const renderThreadRow = (
                          thread: EnvironmentThreadShell,
                          section: SidebarSection,
                          // The tree row of the project folder this row sits in.
                          folderRow?: string,
                        ) => {
                          const threadKey = scopedThreadKey(
                            scopeThreadRef(thread.environmentId, thread.id),
                          );
                          const isCard =
                            section === "active" || section === "pinned" || section === "working";
                          const rowVariant = folderRow
                            ? folderRowsMultiline
                              ? "folder-multiline"
                              : "folder"
                            : isCard
                              ? "card"
                              : "slim";
                          return (
                            <SortableThreadRow
                              key={threadKey}
                              sortableId={threadKey}
                              contextDrag={isContextDrag}
                              sortableDisabled={
                                projectFolders !== null ||
                                renamingThreadKey === threadKey ||
                                !draggableThreadKeys.has(threadKey) ||
                                optimisticDrop !== null
                              }
                              thread={thread}
                              variant={rowVariant}
                              navigationParent={
                                folderRow ??
                                (section === "working" ||
                                section === "snoozed" ||
                                section === "settled"
                                  ? `shelf:${section}`
                                  : undefined)
                              }
                              variantAction={
                                section === "snoozed"
                                  ? "unsnooze"
                                  : section === "settled"
                                    ? "unsettle"
                                    : "settle"
                              }
                              settlementSupported={serverConfigs.has(thread.environmentId)}
                              snoozeSupported={serverConfigs.has(thread.environmentId)}
                              pinningSupported={serverConfigs.has(thread.environmentId)}
                              isPinned={thread.pinnedAt != null}
                              dropVerb={
                                dragState?.activeKey === threadKey
                                  ? resolveSidebarDropVerb(dragState.activeSection, dragTargetSection)
                                  : null
                              }
                              dragOverPinned={
                                dragState?.activeKey === threadKey && dragTargetSection === "pinned"
                              }
                              sweepAction={
                                actionSweep?.keys.has(threadKey) ? actionSweep.action : null
                              }
                              snoozeWakeLabelText={
                                section === "snoozed" && thread.snoozedUntil != null
                                  ? snoozeWakeLabel(thread.snoozedUntil, {
                                      now: new Date().toISOString(),
                                    })
                                  : null
                              }
                              wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                              isActive={routeRowThreadKey === threadKey}
                              revealRef={
                                routeRowThreadKey === threadKey ? revealActiveRow : undefined
                              }
                              isRouteThread={routeThreadKey === threadKey}
                              openPullRequestsInRightPanel={routeThreadRef !== null}
                              jumpLabel={
                                showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null
                              }
                              currentEnvironmentId={primaryEnvironmentId}
                              environmentLabel={
                                environmentLabelById.get(thread.environmentId) ?? null
                              }
                              environmentMachine={
                                environmentMachineById.get(thread.environmentId) ?? "server"
                              }
                              scratchMachineLabel={scratchMachineLabelFor(thread)}
                              project={
                                projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                                null
                              }
                              projectDisplayName={
                                projectDisplayNameByKey.get(
                                  `${thread.environmentId}:${thread.projectId}`,
                                ) ?? null
                              }
                              providerEntryByInstanceId={
                                providerEntriesByEnvironment.get(thread.environmentId) ??
                                EMPTY_PROVIDER_ENTRIES
                              }
                              timestampFormat={timestampFormat}
                              onThreadClick={handleThreadClick}
                              onThreadActivate={navigateToThread}
                              onStartRename={startThreadRename}
                              onRenameTitleChange={setRenamingTitle}
                              onCommitRename={commitThreadRename}
                              onCancelRename={cancelThreadRename}
                              isRenaming={renamingThreadKey === threadKey}
                              renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                              onContextMenu={handleThreadContextMenu}
                              onSettle={attemptSettle}
                              onActionSweepStart={startActionSweep}
                              onUnsettle={attemptUnsettle}
                              onSnooze={attemptSnooze}
                              onUnsnooze={attemptUnsnooze}
                              onUnpin={attemptUnpin}
                              onAcknowledgeWoke={acknowledgeWoke}
                              onFileDropThreads={handleThreadFileDrop}
                            />
                          );
                        };
                        const from = isContextDrag ? null : (dragState?.activeSection ?? null);
                        const items: ReactNode[] = [
                          <SidebarDraftBlock
                            key="draft-sessions"
                            projectByKey={projectByKey}
                            projectDisplayNameByKey={projectDisplayNameByKey}
                            scopedProjectKeys={scopedProjectKeys}
                            routeDraftId={routeDraftIdForRows}
                            onNavigateToDraft={navigateToDraft}
                            onDraftContextMenu={handleDraftContextMenu}
                          />,
                        ];
                        for (const item of sidebarListItems) {
                          if (item.kind === "thread") {
                            // Folders draw active rows in their own place below.
                            if (projectFolders !== null && item.section === "active") continue;
                            items.push(renderThreadRow(threadByKey.get(item.key)!, item.section));
                            continue;
                          }
                          if (projectFolders !== null && item.marker === "active-placeholder") {
                            for (const folder of projectFolders) {
                              items.push(
                                <SidebarProjectFolderHeader
                                  key={`project-folder:${folder.group.projectKey}`}
                                  group={folder.group}
                                  collapsed={folder.collapsed}
                                  hiddenThreads={folder.hiddenThreads}
                                  onToggle={toggleProjectFolder}
                                  onNewThread={startThreadInProjectFolder}
                                  onContextMenu={handleProjectFolderContextMenu}
                                />,
                              );
                              for (const thread of folder.threads) {
                                items.push(
                                  renderThreadRow(
                                    thread,
                                    "active",
                                    sidebarFolderRowId(folder.group.projectKey),
                                  ),
                                );
                              }
                            }
                            continue;
                          }
                          switch (item.marker) {
                            case "pinned-header":
                              items.push(
                                <SidebarDragBoundary
                                  key="pinned-header"
                                  marker="pinned-header"
                                  label="Pinned"
                                  visible={from !== null}
                                  isDropTarget={dragTargetSection === "pinned"}
                                />,
                              );
                              break;
                            case "pinned-divider":
                              items.push(
                                <SidebarDragBoundary
                                  key="pinned-divider"
                                  marker="pinned-divider"
                                  label="Active"
                                  visible={from !== null}
                                  isDropTarget={dragTargetSection === "active"}
                                />,
                              );
                              break;
                            case "active-placeholder":
                              items.push(
                                <SidebarSectionPlaceholder
                                  key="active-placeholder"
                                  marker="active-placeholder"
                                  label="Active"
                                  showHint={
                                    from !== null &&
                                    (activeThreads.length === 0 ||
                                      (from === "active" &&
                                        activeThreads.length === 1 &&
                                        dragTargetSection !== null &&
                                        dragTargetSection !== "active"))
                                  }
                                  isDropTarget={dragTargetSection === "active"}
                                />,
                              );
                              break;
                            case "working-header":
                              items.push(
                                <SidebarSectionHeader
                                  key="working-shelf-header"
                                  marker="working-header"
                                  className="mt-auto"
                                  label="Working"
                                  count={workingThreads.length}
                                  toggle={{
                                    expanded: workingShelfExpanded,
                                    onToggle: toggleWorkingShelf,
                                  }}
                                />,
                              );
                              break;
                            case "snoozed-header":
                              items.push(
                                <SidebarSectionHeader
                                  key="snoozed-shelf-header"
                                  marker="snoozed-header"
                                  className={cn(workingThreads.length === 0 && "mt-auto")}
                                  label="Snoozed"
                                  count={snoozedThreads.length}
                                  toggle={{
                                    expanded: snoozedShelfExpanded,
                                    onToggle: toggleSnoozedShelf,
                                  }}
                                />,
                              );
                              break;
                            case "settled-header":
                              items.push(
                                <SidebarSectionHeader
                                  key="settled-shelf-header"
                                  marker="settled-header"
                                  className={cn(
                                    workingThreads.length + snoozedThreads.length === 0 && "mt-auto",
                                  )}
                                  label="Settled"
                                  count={settledCount}
                                  dragging={from !== null}
                                  isDropTarget={dragTargetSection === "settled"}
                                  toggle={{
                                    expanded: settledShelfExpanded,
                                    onToggle: toggleSettledShelf,
                                  }}
                                />,
                              );
                              break;
                            case "settled-placeholder":
                              items.push(
                                <SidebarSectionPlaceholder
                                  key="settled-placeholder"
                                  marker="settled-placeholder"
                                  label="Settled"
                                  showHint={
                                    from !== null &&
                                    (renderedSettledThreads.length === 0 ||
                                      (from === "settled" &&
                                        renderedSettledThreads.length === 1 &&
                                        dragTargetSection !== null &&
                                        dragTargetSection !== "settled"))
                                  }
                                  isDropTarget={dragTargetSection === "settled"}
                                />,
                              );
                              break;
                          }
                        }
                        return items;
                      })()}
                      {settledShelfExpanded && hiddenSettledCount > 0 ? (
                        <li className="list-none">
                          <button
                            type="button"
                            data-sidebar-row="settled:more"
                            data-sidebar-parent="shelf:settled"
                            disabled={olderSettledShelf.loading}
                            onClick={() => {
                              olderSettledShelf.retry();
                              showMoreSettled();
                            }}
                            className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:cursor-default"
                          >
                            {/* Plus means "add", so revealing more uses a chevron. */}
                            <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
                            {olderSettledShelf.loading
                              ? "Loading"
                              : olderSettledShelf.failed
                                ? "Could not load older threads. Retry"
                                : `Show ${Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more`}
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  </SortableContext>
                </DndContext>
              </TooltipProvider>
            ) : null}
            {!isSearchingThreads &&
            !hasProjectFolders &&
            visibleDraftSessionCount === 0 &&
            pinnedThreads.length +
              activeThreads.length +
              workingThreads.length +
              snoozedThreads.length +
              settledCount ===
              0 ? (
              <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
                {projects.length === 0 ? (
                  <>
                    <span>No projects yet</span>
                    <button
                      type="button"
                      onClick={openAddProjectCommandPalette}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    >
                      <PlusIcon className="-mx-0.5 size-3" />
                      Add project
                    </button>
                  </>
                ) : scopedProjectGroups.length > 1 ? (
                  "No threads in these projects yet"
                ) : scopedProjectGroups[0] ? (
                  `No threads in ${scopedProjectGroups[0].displayName} yet`
                ) : (
                  "No threads yet"
                )}
              </div>
            ) : null}
          </SidebarGroup>
  );
}
