import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { applyPullRequestDraftFilterChange } from "@t3tools/client-runtime/pull-request-query";
import { Spinner } from "~/components/ui/spinner";

import { sortProjectsByGroupOrder } from "@t3tools/client-runtime/state/project-grouping";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListState,
} from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { ArrowDownUpIcon, LayersIcon, Plug2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type ComponentProps } from "react";

import { pullRequestEntryKey, pullRequestOverrideAfterAction } from "./pullRequestList.logic";

import { environmentMachineIcon } from "../EnvironmentMachineIcon";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";
import {
  PullRequestFiltersMenu,
  PullRequestSearchInput,
  pullRequestHostLabel,
  pullRequestProjectKey,
  type PullRequestFilterOption,
} from "./PullRequestListFilters";
import { PullRequestCompactFilterMenu } from "./PullRequestCompactFilterMenu";
import { INVOLVEMENT_TABS, SORT_OPTIONS, STATE_TABS } from "./pullRequestListOptions";
import { PullRequestsColumn } from "./PullRequestsColumn";
import { PullRequestListGroups } from "./PullRequestListGroups";

import { pullRequestListEntryId } from "./pullRequestListGroups.logic";
import { PullRequestListEmptyState } from "./PullRequestListEmptyState";
import { PullRequestListGhost } from "./PullRequestGhosts";
import { type PullRequestRowTarget } from "./PullRequestRow";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { RightPanelTabs } from "../RightPanelTabs";
import { isCommandPaletteOpen } from "~/commandPaletteBus";

import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";

import { PanelLayoutControls, RightPanelMaximizeControl } from "../chat/PanelLayoutControls";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";

import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
  type PullRequestSurface,
} from "~/rightPanelStore";
import { useSidebarProjectGroups } from "~/hooks/useSidebarProjectGroups";

import { cn } from "~/lib/utils";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { usePullRequestsPageListState } from "./usePullRequestsPageListState";
import { usePullRequestsPageState } from "./usePullRequestsPageState";

/**
 * One whole page from the host and no more: every provider asks for one row beyond the page as
 * its "is there more" probe, and GitHub serves a hundred per request — so asking for ninety-nine
 * costs one round trip where a hundred costs two.
 */
const MAX_PAGE_SIZE = 500;
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const EMPTY_PENDING_SURFACES = new Set<string>();
function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

export function PullRequestsPage() {
  const {
    activePullRequestSurface,
    canContinue,
    capabilityKnown,
    capableEnvironments,
    clearedSelection,
    closeSweepKeys,
    closingKeys,
    detailOverrideTokens,
    detailRefreshToken,
    displayGroups,
    entries,
    environmentLabels,
    expectedHosts,
    facets,
    filterOptionScope,
    firstLoad,
    heldPullRequestsBySurface,
    hostActionsOf,
    hosts,
    keybindings,
    linkedSelection,
    listData,
    listErrors,
    listQuery,
    listedPullRequestTabStatuses,
    listedPullRequestsBySurface,
    loadMore,
    loadingMore,
    menuFiltered,
    menuFilters,
    onSpeedAction,
    openPanelPullRequestUrl,
    overrideEntry,
    pageSize,
    panelAnimationDurationMs,
    panelAnimationsActive,
    panelEnvironmentId,
    projects,
    projectsKnown,
    pullRequestsSupported,
    querySettled,
    refreshFromHost,
    refreshListAndStats,
    refreshing,
    registerStatsRow,
    renderedPullRequestSurface,
    renderedRightPanelSurfaces,
    revertOverride,
    rightPanelPresent,
    rightPanelRef,
    rightPanelState,
    scopedEnvironmentId,
    scopedProject,
    scopedProjectId,
    scopedProjects,
    scrollRef,
    search,
    selectedProject,
    selectedPullRequestSurface,
    sentCursors,
    setFiltersOpen,
    showProvider,
    showingCarried,
    shownCount,
    sort,
    startCloseSweep,
    submitQuery,
    typedParsed,
    typedQuery,
    updateListScope,
    updateSearch,
  } = usePullRequestsPageListState(usePullRequestsPageState());
  const rightPanelAvailable = selectedPullRequestSurface !== null;
  const [maximized, setMaximized] = useState(false);
  const rightPanelMaximized = rightPanelState.isOpen && maximized;
  if (!rightPanelState.isOpen && maximized) setMaximized(false);
  const toggleRightPanelMaximized = () => {
    if (rightPanelState.isOpen) setMaximized((value) => !value);
  };
  const onGuideShown = () => setMaximized(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the URL-linked pull request in the right panel store
  useEffect(() => {
    if (!pullRequestsSupported || rightPanelRef === null || linkedSelection === null) return;
    useRightPanelStore.getState().openPullRequest(rightPanelRef, linkedSelection);
  }, [linkedSelection, pullRequestsSupported, rightPanelRef]);

  const selected =
    rightPanelState.isOpen && activePullRequestSurface !== null
      ? {
          environmentId: activePullRequestSurface.environmentId,
          repository: activePullRequestSurface.repository,
          number: activePullRequestSurface.number,
          projectId: activePullRequestSurface.projectId as ProjectId,
          host:
            activePullRequestSurface.host ??
            (selectedProject?.repositoryIdentity
              ? sourceControlClients.changeRequestHost(
                  selectedProject.repositoryIdentity,
                  selectedProject.repositoryIdentity.provider,
                )
              : undefined),
        }
      : null;

  const selectSurfaceInUrl = (surface: PullRequestSurface | null) =>
    updateSearch(
      surface === null
        ? clearedSelection
        : {
            repository: surface.repository,
            number: surface.number,
            selectedProjectId: surface.projectId as ProjectId,
            selectedHost: surface.host,
            ...(surface.environmentId === undefined
              ? {}
              : { selectedEnvironmentId: surface.environmentId as EnvironmentId }),
          },
    );

  const toggleRightPanel = () => {
    if (rightPanelRef === null) return;
    if (rightPanelState.isOpen) {
      useRightPanelStore.getState().close(rightPanelRef);
      updateSearch(clearedSelection);
      return;
    }
    if (selectedPullRequestSurface === null) return;
    useRightPanelStore.getState().show(rightPanelRef);
    selectSurfaceInUrl(selectedPullRequestSurface);
  };

  const unavailableProjects = new Map(
    listErrors.map(
      (error) =>
        [
          pullRequestProjectKey({ id: error.projectId, environmentId: error.environmentId }),
          error.message,
        ] as const,
    ),
  );

  const selectEntry = (entry: PullRequestRowTarget) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().openPullRequest(rightPanelRef, entry);
    updateSearch({
      repository: entry.repository,
      number: entry.number,
      selectedProjectId: entry.projectId,
      selectedEnvironmentId: entry.environmentId,
      selectedHost: entry.host,
    });
  };

  const searchInput = (
    <PullRequestSearchInput
      value={search.q ?? ""}
      busy={typedQuery.length > 0 && (!querySettled || showingCarried)}
      onChange={(query) => updateListScope({ q: query || undefined })}
      onSubmit={submitQuery}
    />
  );
  const panelToggleControls = (
    <PanelLayoutControls
      showTerminalControl={false}
      showThreadPanelControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      threadPanelOpen={false}
      threadPanelPresentation="inline"
      threadPanelShortcutLabel={null}
      onToggleThreadPanel={() => undefined}
      rightPanelAvailable={rightPanelAvailable}
      rightPanelOpen={rightPanelState.isOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      rightPanelUnavailableLabel="Select a pull request first"
      onToggleTerminal={() => undefined}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const openPanelControls = (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      {rightPanelState.isOpen ? (
        <RightPanelMaximizeControl
          maximized={rightPanelMaximized}
          onToggle={toggleRightPanelMaximized}
        />
      ) : null}
      {panelToggleControls}
    </div>
  );
  const carriedToNothing =
    shownCount === 0 &&
    typedQuery.length === 0 &&
    (!querySettled || (showingCarried && listQuery.isPending));
  const listBody = (
    <>
      {!capabilityKnown ? (
        <PullRequestListGhost rows={7} caption="Loading pull requests…" />
      ) : !pullRequestsSupported ? (
        <PullRequestsUnavailableState
          title="Pull requests unavailable"
          error="Update your T3 Code servers to browse pull requests."
        />
      ) : firstLoad ? (
        <PullRequestListGhost rows={7} caption="Loading pull requests…" />
      ) : listQuery.error && shownCount === 0 ? (
        <PullRequestsUnavailableState
          error={listQuery.error}
          refreshing={listQuery.isPending}
          onRetry={() => listQuery.refresh()}
        />
      ) : carriedToNothing ? (
        <PullRequestListGhost rows={7} />
      ) : shownCount === 0 ? (
        <PullRequestListEmptyState
          hasProjects={!projectsKnown || projects.length > 0}
          refreshing={refreshing}
          onRefresh={() => void refreshFromHost()}
          query={typedQuery}
          filtered={
            menuFiltered ||
            search.state !== "open" ||
            search.involvement !== "all" ||
            scopedProjectId !== undefined ||
            search.host !== undefined
          }
          searching={typedQuery.length > 0 && (!querySettled || showingCarried)}
          canLoadMore={listData?.truncated === true && (canContinue || pageSize < MAX_PAGE_SIZE)}
          loadingMore={loadingMore}
          onClearQuery={() => updateListScope({ q: undefined })}
          onLoadMore={loadMore}
        />
      ) : (
        <PullRequestListGroups
          groups={displayGroups}
          environmentLabels={capableEnvironments.length > 1 ? environmentLabels : null}
          query={typedParsed.text}
          selected={selected}
          showProvider={showProvider}
          statsRef={registerStatsRow}
          onSelect={selectEntry}
          hostActionsOf={hostActionsOf}
          onActed={onSpeedAction}
          closingKeys={closingKeys}
          sweepingKeys={closeSweepKeys}
          onCloseSweepStart={startCloseSweep}
        />
      )}

      {listQuery.error && shownCount > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
          <span>{listQuery.error} Showing the last pull requests loaded.</span>
          <Button size="xs" variant="outline" onClick={() => listQuery.refresh()}>
            Retry
          </Button>
        </div>
      ) : null}
      {listData?.truncated && entries.length > 0 ? (
        <div className="flex justify-center py-3 text-xs text-muted-foreground">
          {loadingMore ? (
            <span className="flex items-center gap-2">
              <Spinner aria-hidden size="sm" />
              {sentCursors === null ? "Updating pull requests" : "Loading more"}
            </span>
          ) : canContinue || pageSize < MAX_PAGE_SIZE ? (
            <Button
              size="sm"
              variant="outline"
              onClick={loadMore}
              disabled={listQuery.isPending || showingCarried}
            >
              Load more pull requests
            </Button>
          ) : (
            <span>Narrow your search to find more pull requests.</span>
          )}
        </div>
      ) : null}
    </>
  );
  const hostEntries = hosts.length > 0 ? hosts : expectedHosts;
  const hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: "", label: "All", Icon: Plug2Icon },
    ...hostEntries.map((entry) => {
      const summary = hosts.find((host) => host.host === entry.host);
      return {
        value: entry.host,
        label: pullRequestHostLabel(hostEntries, entry),
        Icon: getSourceControlPresentationForKind(entry.kind).Icon,
        ...(summary === undefined || summary.configured
          ? {}
          : { unavailable: summary.detail ?? "This host could not be read." }),
      };
    }),
  ];
  const serverMenuOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: "", label: "All servers", Icon: LayersIcon },
    ...capableEnvironments.map((environment) => ({
      value: environment.environmentId,
      label: environment.label,
      Icon: environmentMachineIcon(resolveEnvironmentMachineKind(environment.serverConfig)),
    })),
  ];
  const sortMenu = (
    <PullRequestCompactFilterMenu
      label="Sort pull requests"
      triggerIcon={<ArrowDownUpIcon aria-hidden className="size-4" />}
      triggerLabel="Sort"
      outlined
      value={sort}
      options={SORT_OPTIONS}
      onChange={(next) => updateListScope({ sort: next })}
    />
  );
  const filtersMenu = (
    <PullRequestFiltersMenuInSidebarOrder
      onOpenChange={setFiltersOpen}
      state={search.state}
      stateOptions={STATE_TABS}
      onState={(state) => updateListScope({ state })}
      involvement={search.involvement}
      involvementOptions={INVOLVEMENT_TABS}
      onInvolvement={(involvement) => updateListScope({ involvement })}
      filters={
        typedParsed.filters.draft
          ? { ...menuFilters, draft: typedParsed.filters.draft }
          : menuFilters
      }
      onFilters={(value) => {
        const { query, filters: next } = applyPullRequestDraftFilterChange(
          typedQuery,
          menuFilters,
          value,
        );
        updateListScope({
          ...(query === typedQuery ? {} : { q: query || undefined }),
          draft: next.draft,
          review: next.review,
          checks: next.checks,
          author: next.author,
          labels: next.labels?.flatMap((group) => group),
        });
      }}
      authorOptions={facets.authors}
      labelOptions={facets.labels}
      optionScope={filterOptionScope}
      host={search.host}
      hostOptions={hostMenuOptions}
      onHost={(host) => updateListScope({ host })}
      server={scopedEnvironmentId ?? undefined}
      serverOptions={serverMenuOptions}
      onServer={(server) => updateListScope({ environmentId: server, projectId: undefined })}
      projects={scopedProjects}
      projectId={scopedProjectId}
      projectEnvironmentId={scopedProject?.environmentId}
      unavailable={unavailableProjects}
      onProject={(projectId, environmentId) =>
        updateListScope(environmentId === undefined ? { projectId } : { projectId, environmentId })
      }
    />
  );
  const columnProps = {
    refreshing,
    onRefresh: () => void refreshFromHost(),
    searchValue: search.q ?? "",
    involvement: search.involvement,
    state: search.state,
    host: search.host,
    hostMenuOptions,
    onInvolvement: (involvement: PullRequestInvolvement) => updateListScope({ involvement }),
    onState: (state: PullRequestListState) => updateListScope({ state }),
    onHost: (host: string | undefined) => updateListScope({ host }),
    searchInput,
    sortMenu,
    filtersMenu,
    rightPanelControl: !pullRequestsSupported ? null : (
      <span
        aria-hidden
        className={cn(
          "shrink-0",
          rightPanelState.isOpen ? "-ml-3 w-0" : "w-7 sm:w-5",
          panelAnimationsActive && "transition-[width,margin] ease-out",
        )}
        style={
          panelAnimationsActive
            ? { transitionDuration: `${panelAnimationDurationMs}ms` }
            : undefined
        }
      />
    ),
    titlebarControls:
      // While the panel is closed the strip lives inside the header: a no-drag
      // descendant beats the header's desktop drag-region, where a floating
      // sibling loses (app-region hit-testing ignores z-index).
      pullRequestsSupported ? (
        rightPanelPresent ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-full w-7 [-webkit-app-region:no-drag]"
          />
        ) : (
          openPanelControls
        )
      ) : null,
    rightPanelOpen: rightPanelState.isOpen,
    maximizedAway: rightPanelMaximized,
    listBody,
    scrollRef,
  };

  const activateSurface = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().activateSurface(rightPanelRef, surface.id);
    selectSurfaceInUrl(surface);
  };
  const closeSurface = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurface(rightPanelRef, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      rightPanelRef,
    );
    selectSurfaceInUrl(next?.kind === "pull-request" ? next : null);
  };
  const closeOtherSurfaces = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeOtherSurfaces(rightPanelRef, surface.id);
    selectSurfaceInUrl(surface);
  };
  const closeSurfacesToRight = (surface: PullRequestSurface) => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeSurfacesToRight(rightPanelRef, surface.id);
    const next = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      rightPanelRef,
    );
    selectSurfaceInUrl(next?.kind === "pull-request" ? next : null);
  };
  const closeAllSurfaces = () => {
    if (rightPanelRef === null) return;
    useRightPanelStore.getState().closeAllSurfaces(rightPanelRef);
    selectSurfaceInUrl(null);
  };

  const copyPullRequestFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!openPanelPullRequestUrl) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const url = openPanelPullRequestUrl;
    const { shortLabel, singular } = (
      sourceControlClients.findByChangeRequestUrl(url) ?? sourceControlClients.get(undefined)
    ).changeRequest;
    void writeTextToClipboard(url, `${singular} link`).then(
      (didCopy) => {
        if (didCopy)
          toastManager.add({
            type: "success",
            title: `${shortLabel} link copied`,
            description: url,
          });
      },
      (error) => {
        toastManager.add({
          type: "error",
          title: `Failed to copy ${shortLabel} link`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
  });
  const closeActiveSurfaceFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (activePullRequestSurface === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) closeSurface(activePullRequestSurface);
  });
  const toggleRightPanelFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!rightPanelAvailable) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggleRightPanel();
  });
  const toggleRightPanelMaximizedFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!rightPanelState.isOpen) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggleRightPanelMaximized();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document keydown listener for the right panel and copy-reference shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: getShortcutContext(),
      });
      if (command === "rightPanel.close") closeActiveSurfaceFromShortcut(event);
      if (command === "rightPanel.toggle") toggleRightPanelFromShortcut(event);
      if (command === "rightPanel.toggleMaximized") toggleRightPanelMaximizedFromShortcut(event);
      if (command === "thread.copyReference") copyPullRequestFromShortcut(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1">
        {pullRequestsSupported && rightPanelPresent ? openPanelControls : null}
        <PullRequestsColumn {...columnProps} />

        {rightPanelPresent && renderedPullRequestSurface && panelEnvironmentId !== null ? (
          <RightPanelTabs
            mode="inline"
            open={rightPanelState.isOpen}
            maximized={rightPanelMaximized}
            keybindings={keybindings}
            getShortcutContext={getShortcutContext}
            widthStorageKey="t3code:pull-request-panel-width"
            defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
            surfaces={renderedRightPanelSurfaces}
            environmentId={panelEnvironmentId}
            activeSurfaceId={renderedPullRequestSurface.id}
            pendingSurfaceIds={EMPTY_PENDING_SURFACES}
            previewSessions={EMPTY_PREVIEW_SESSIONS}
            desktopByTabId={EMPTY_PREVIEW_DESKTOP_STATE}
            terminalLabelsById={EMPTY_TERMINAL_LABELS}
            onActivate={(surface) => {
              if (surface.kind === "pull-request") activateSurface(surface);
            }}
            onCloseSurface={(surface) => {
              if (surface.kind === "pull-request") closeSurface(surface);
            }}
            onCloseOtherSurfaces={(surface) => {
              if (surface.kind === "pull-request") closeOtherSurfaces(surface);
            }}
            onCloseSurfacesToRight={(surface) => {
              if (surface.kind === "pull-request") closeSurfacesToRight(surface);
            }}
            onCloseAllSurfaces={closeAllSurfaces}
            onMoveSurface={(surfaceId, toIndex) => {
              if (rightPanelRef !== null)
                useRightPanelStore.getState().moveSurface(rightPanelRef, surfaceId, toIndex);
            }}
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddBrowserInProfile={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddPullRequests={() => undefined}
            onAddDevice={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            pullRequestsAvailable={false}
            deviceAvailable={false}
            pullRequestStatusSeeds={listedPullRequestTabStatuses}
          >
            <PullRequestDetailPanel
              getShortcutContext={getShortcutContext}
              shortcutsEnabled={activePullRequestSurface?.id === renderedPullRequestSurface.id}
              key={renderedPullRequestSurface.id}
              environmentId={panelEnvironmentId}
              onGuideShown={onGuideShown}
              onSelectPullRequest={(reference) => {
                if (rightPanelRef === null) return;
                useRightPanelStore.getState().openPullRequest(rightPanelRef, {
                  projectId: reference.projectId,
                  repository: reference.repository,
                  number: reference.number,
                  ...(reference.host ? { host: reference.host } : {}),
                  environmentId: panelEnvironmentId,
                });
                updateSearch({
                  repository: reference.repository,
                  number: reference.number,
                  selectedHost: reference.host,
                  selectedProjectId: reference.projectId,
                  selectedEnvironmentId: panelEnvironmentId,
                });
              }}
              reference={{
                projectId: renderedPullRequestSurface.projectId as ProjectId,
                repository: renderedPullRequestSurface.repository,
                number: renderedPullRequestSurface.number,
                ...(renderedPullRequestSurface.host
                  ? { host: renderedPullRequestSurface.host }
                  : {}),
              }}
              listEntry={
                listedPullRequestsBySurface.get(
                  pullRequestListEntryId(renderedPullRequestSurface),
                ) ?? null
              }
              refreshToken={detailRefreshToken}
              tabOnPage
              onActed={(action, phase = "done") => {
                // From every row held, not the ones on screen: a pull request closed from an open
                // list has left the screen, and reopening it has to find it anyway.
                const acted = heldPullRequestsBySurface.get(
                  pullRequestListEntryId(renderedPullRequestSurface),
                );
                const stateOnly =
                  action !== undefined &&
                  acted !== undefined &&
                  pullRequestOverrideAfterAction(acted, action, new Date(), 0) !== null;
                if (stateOnly) {
                  const key = pullRequestEntryKey(acted);
                  if (phase === "sent" && action !== "merge") {
                    detailOverrideTokens.current.set(key, overrideEntry(acted, action));
                  }
                  if (phase === "failed" && action !== "merge") {
                    revertOverride(key, detailOverrideTokens.current.get(key) ?? null);
                  }
                  if (phase !== "sent") detailOverrideTokens.current.delete(key);
                  if (phase === "done" && action === "merge") {
                    overrideEntry(acted, action);
                    refreshListAndStats(undefined, panelEnvironmentId);
                  }
                  return;
                }
                if (phase === "done") refreshListAndStats(undefined, panelEnvironmentId);
              }}
            />
          </RightPanelTabs>
        ) : null}
      </div>
    </SidebarInset>
  );
}

function PullRequestFiltersMenuInSidebarOrder(
  props: ComponentProps<typeof PullRequestFiltersMenu>,
) {
  const sidebarProjectGroups = useSidebarProjectGroups();
  const projects = sortProjectsByGroupOrder(props.projects, sidebarProjectGroups);
  return <PullRequestFiltersMenu {...props} projects={projects} />;
}
