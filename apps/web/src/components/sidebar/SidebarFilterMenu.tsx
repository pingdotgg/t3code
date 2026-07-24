import {
  DEFAULT_SIDEBAR_THREAD_FILTERS,
  SIDEBAR_THREAD_FILTER_STATUSES,
  type SidebarThreadFilters,
  type SidebarThreadFilterStatus,
} from "@t3tools/contracts/settings";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { ListFilterIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { hasActiveSidebarThreadFilters } from "../Sidebar.logic";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SIDEBAR_THREAD_FILTER_STATUS_LABELS: Record<SidebarThreadFilterStatus, string> = {
  needs_attention: "Needs attention",
  unread: "Unread",
  working: "Working",
  done: "Done",
};

export interface SidebarFilterProjectOption {
  readonly id: string;
  readonly label: string;
  readonly projectKeys: readonly string[];
}

export interface SidebarFilterEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface SidebarFilterProviderOption {
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
}

export function toggleSidebarFilterValue<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) {
    return values.includes(value) ? [...values] : [...values, value];
  }
  return values.filter((candidate) => candidate !== value);
}

export function toggleSidebarFilterValues<T>(
  values: readonly T[],
  toggledValues: readonly T[],
  checked: boolean,
): T[] {
  const next = new Set(values);
  for (const value of toggledValues) {
    if (checked) {
      next.add(value);
    } else {
      next.delete(value);
    }
  }
  return [...next];
}

export function SidebarFilterMenu({
  filters,
  environments,
  projects,
  providerSources,
  archiveLoading,
  archiveError,
  onFiltersChange,
  showGroupByProject = true,
  triggerClassName,
}: {
  filters: SidebarThreadFilters;
  environments: ReadonlyArray<SidebarFilterEnvironmentOption>;
  projects: ReadonlyArray<SidebarFilterProjectOption>;
  providerSources: ReadonlyArray<SidebarFilterProviderOption>;
  archiveLoading: boolean;
  archiveError: string | null;
  onFiltersChange: (filters: SidebarThreadFilters) => void;
  showGroupByProject?: boolean;
  triggerClassName?: string;
}) {
  const filtersActive = hasActiveSidebarThreadFilters(filters);
  const statusFilterActive =
    filters.statuses.length !== SIDEBAR_THREAD_FILTER_STATUSES.length ||
    !SIDEBAR_THREAD_FILTER_STATUSES.every((status) => filters.statuses.includes(status));

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Filter sidebar threads"
              data-testid="sidebar-filter-trigger"
              className={cn(
                "relative inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] transition-colors hover:bg-accent hover:text-foreground",
                filtersActive ? "text-primary" : "text-muted-foreground/60",
                triggerClassName,
              )}
            />
          }
        >
          <ListFilterIcon className="size-3.5" />
          {filtersActive ? (
            <span className="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-primary ring-1 ring-sidebar" />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {filtersActive ? "Sidebar filters are active" : "Filter sidebar threads"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="w-60">
        {showGroupByProject ? (
          <>
            <MenuCheckboxItem
              checked={filters.groupByProject}
              closeOnClick={false}
              className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs"
              onCheckedChange={(checked) => {
                onFiltersChange({ ...filters, groupByProject: checked });
              }}
            >
              Group by project
            </MenuCheckboxItem>
            <MenuSeparator className="my-0.5" />
          </>
        ) : null}
        <div className="flex items-center justify-between px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <span>Filters</span>
          <MenuItem
            closeOnClick={false}
            className="min-h-0 cursor-pointer p-0 text-[11px] text-muted-foreground hover:text-foreground sm:min-h-0 sm:text-[11px]"
            disabled={!filtersActive}
            onClick={() => {
              onFiltersChange({
                ...DEFAULT_SIDEBAR_THREAD_FILTERS,
                groupByProject: filters.groupByProject,
              });
            }}
          >
            Reset
          </MenuItem>
        </div>
        <MenuCheckboxItem
          checked={filters.recentOnly}
          closeOnClick={false}
          className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs"
          onCheckedChange={(checked) => {
            onFiltersChange({ ...filters, recentOnly: checked });
          }}
        >
          <span className="flex min-w-0 items-center justify-between gap-3">
            <span>Recent</span>
            <span className="text-[10px] text-muted-foreground">Last 7 days</span>
          </span>
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={filters.attentionOnly}
          closeOnClick={false}
          className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs"
          onCheckedChange={(checked) => {
            onFiltersChange({ ...filters, attentionOnly: checked });
          }}
        >
          <span className="flex min-w-0 items-center justify-between gap-3">
            <span>Inbox</span>
            <span className="text-[10px] text-muted-foreground">Unread + needs attention</span>
          </span>
        </MenuCheckboxItem>
        <MenuSeparator className="my-0.5" />
        <MenuSub>
          <MenuSubTrigger className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs">
            <span>Status</span>
            {statusFilterActive ? (
              <span className="ml-auto size-1.5 rounded-full bg-primary" />
            ) : null}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            {SIDEBAR_THREAD_FILTER_STATUSES.map((status) => (
              <MenuCheckboxItem
                key={status}
                checked={filters.statuses.includes(status)}
                closeOnClick={false}
                className="sm:text-xs"
                onCheckedChange={(checked) => {
                  onFiltersChange({
                    ...filters,
                    statuses: toggleSidebarFilterValue(filters.statuses, status, checked),
                  });
                }}
              >
                {SIDEBAR_THREAD_FILTER_STATUS_LABELS[status]}
              </MenuCheckboxItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs">
            <span>Project</span>
            {filters.projectKeys.length > 0 ? (
              <span className="ml-auto size-1.5 rounded-full bg-primary" />
            ) : null}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-56">
            {projects.map((project) => {
              const checked =
                filters.projectKeys.length > 0 &&
                project.projectKeys.every((projectKey) => filters.projectKeys.includes(projectKey));
              return (
                <MenuCheckboxItem
                  key={project.id}
                  checked={checked}
                  closeOnClick={false}
                  className="sm:text-xs"
                  onCheckedChange={(nextChecked) => {
                    onFiltersChange({
                      ...filters,
                      projectKeys: toggleSidebarFilterValues(
                        filters.projectKeys,
                        project.projectKeys,
                        nextChecked,
                      ),
                    });
                  }}
                >
                  <span className="truncate">{project.label}</span>
                </MenuCheckboxItem>
              );
            })}
            {projects.length === 0 ? (
              <MenuItem disabled className="sm:text-xs">
                No projects
              </MenuItem>
            ) : null}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs">
            <span>Environment</span>
            {filters.environmentIds.length > 0 ? (
              <span className="ml-auto size-1.5 rounded-full bg-primary" />
            ) : null}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            {environments.map((environment) => (
              <MenuCheckboxItem
                key={environment.environmentId}
                checked={filters.environmentIds.includes(environment.environmentId)}
                closeOnClick={false}
                className="sm:text-xs"
                onCheckedChange={(checked) => {
                  onFiltersChange({
                    ...filters,
                    environmentIds: toggleSidebarFilterValue(
                      filters.environmentIds,
                      environment.environmentId,
                      checked,
                    ),
                  });
                }}
              >
                {environment.label}
              </MenuCheckboxItem>
            ))}
            {environments.length === 0 ? (
              <MenuItem disabled className="sm:text-xs">
                No environments
              </MenuItem>
            ) : null}
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs">
            <span>Source</span>
            {filters.sources.length > 0 ? (
              <span className="ml-auto size-1.5 rounded-full bg-primary" />
            ) : null}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            {providerSources.map((source) => (
              <MenuCheckboxItem
                key={source.driverKind}
                checked={filters.sources.includes(source.driverKind)}
                closeOnClick={false}
                className="sm:text-xs"
                onCheckedChange={(checked) => {
                  onFiltersChange({
                    ...filters,
                    sources: toggleSidebarFilterValue(filters.sources, source.driverKind, checked),
                  });
                }}
              >
                {source.label}
              </MenuCheckboxItem>
            ))}
            {providerSources.length === 0 ? (
              <MenuItem disabled className="sm:text-xs">
                No providers
              </MenuItem>
            ) : null}
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator className="my-0.5" />
        <MenuCheckboxItem
          checked={filters.includeArchived}
          closeOnClick={false}
          className="min-h-6 py-0.5 sm:min-h-6 sm:text-xs"
          onCheckedChange={(checked) => {
            onFiltersChange({ ...filters, includeArchived: checked });
          }}
        >
          <span className="flex items-center gap-2">
            Archived
            {archiveLoading ? <LoaderIcon className="size-3 animate-spin" /> : null}
            {archiveError ? (
              <span
                role="img"
                aria-label={`Archived threads failed to load: ${archiveError}`}
                title={archiveError}
              >
                <TriangleAlertIcon aria-hidden className="size-3 text-warning" />
              </span>
            ) : null}
          </span>
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}
