import {
  ISSUE_STATUSES,
  type IssueListSort,
  type IssueListState,
  type IssueStatus,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  CircleDotDashedIcon,
  CircleSlashIcon,
  FolderGit2Icon,
  LayersIcon,
  MessageSquareIcon,
  MessageSquareOffIcon,
  MilestoneIcon,
} from "lucide-react";

import {
  PullRequestFilterRadioGroup,
  PullRequestFilterRadioSubmenu,
  PullRequestFiltersTrigger,
  PullRequestLabelFilter,
  PullRequestSearchableFilterSubmenu,
  type PullRequestFilterOption,
} from "../pullRequest/PullRequestListFilters";
import { Button } from "../ui/button";
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
import { issueKey, type IssueFacets, type IssueListFilters } from "./issueList.logic";
import {
  ISSUE_STATE_PRESENTATION,
  ISSUE_STATUS_PRESENTATION,
  IssueStatusGlyph,
} from "./issuePresentation";
import type { IssueStatusFilters } from "./issueStatus.logic";

export type IssueMenuFilters = IssueListFilters & IssueStatusFilters;

/** The unset value of each single-choice filter. */
const ANY = "";

export const ISSUE_STATE_OPTIONS = [
  { value: "open", label: "Open", Icon: ISSUE_STATE_PRESENTATION.open.Icon },
  { value: "closed", label: "Closed", Icon: ISSUE_STATE_PRESENTATION.done.Icon },
  { value: "all", label: "All", Icon: LayersIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueListState>>;

const LINKED_OPTIONS = [
  { value: ANY, label: "Linked or not", Icon: LayersIcon },
  { value: "linked", label: "Linked to a thread", Icon: MessageSquareIcon },
  { value: "unlinked", label: "Not linked", Icon: MessageSquareOffIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

/** Issues' Filters menu, built from the pull request list's rows and submenus. */
export function IssueFiltersMenu({
  state,
  onState,
  filters,
  onFilters,
  facets,
  repositories,
}: {
  state: IssueListState;
  onState: (state: IssueListState) => void;
  filters: IssueMenuFilters;
  onFilters: (update: (previous: IssueMenuFilters) => IssueMenuFilters) => void;
  facets: IssueFacets;
  repositories: ReadonlyArray<{
    readonly host: string;
    readonly repository: string;
    readonly projectTitle: string;
  }>;
}) {
  const filterCount =
    (state === "open" ? 0 : 1) +
    (filters.repository ? 1 : 0) +
    (filters.labels?.length ?? 0) +
    (filters.milestone ? 1 : 0) +
    (filters.parent ? 1 : 0) +
    (filters.statuses?.length ?? 0) +
    (filters.linked ? 1 : 0);
  const set = (patch: Partial<IssueMenuFilters>) =>
    onFilters((previous) => ({ ...previous, ...patch }));
  const orUndefined = (value: string) => (value === ANY ? undefined : value);
  const repositoryOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: ANY, label: "All projects", Icon: LayersIcon },
    ...repositories.map((repository) => ({
      value: `${repository.host} ${repository.repository}`,
      label: `${repository.projectTitle} · ${repository.repository}`,
      Icon: FolderGit2Icon,
    })),
  ];
  const milestoneOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: ANY, label: "Any milestone", Icon: LayersIcon },
    // An active milestone stays listed after the loaded rows stop carrying it.
    ...[
      ...facets.milestones,
      ...(filters.milestone && !facets.milestones.includes(filters.milestone)
        ? [filters.milestone]
        : []),
    ].map((milestone) => ({ value: milestone, label: milestone, Icon: MilestoneIcon })),
  ];
  const parentOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: ANY, label: "Any parent", Icon: LayersIcon },
    { value: "none", label: "No parent", Icon: CircleSlashIcon },
    ...facets.parents.map((parent) => ({
      value: issueKey(parent),
      label: `#${parent.number} ${parent.title}`,
      Icon: ISSUE_STATE_PRESENTATION[parent.state].Icon,
    })),
    // Likewise an active parent, named by its number from the key.
    ...(filters.parent &&
    filters.parent !== "none" &&
    !facets.parents.some((parent) => issueKey(parent) === filters.parent)
      ? [
          {
            value: filters.parent,
            label: `#${filters.parent.split("#").at(-1)}`,
            Icon: ISSUE_STATE_PRESENTATION.open.Icon,
          },
        ]
      : []),
  ];
  return (
    <Menu>
      <PullRequestFiltersTrigger count={filterCount} />
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label="State"
          value={state}
          options={ISSUE_STATE_OPTIONS}
          onChange={onState}
        />
        <IssueStatusFilter
          value={filters.statuses ?? []}
          onChange={(statuses) => set({ statuses })}
        />
        <MenuSeparator />
        <PullRequestSearchableFilterSubmenu
          label="Project"
          value={filters.repository ?? ANY}
          options={repositoryOptions}
          onChange={(repository) => set({ repository: orUndefined(repository) })}
          searchLabel="Search projects"
        />
        <PullRequestLabelFilter
          value={filters.labels ?? []}
          options={facets.labels}
          onChange={(labels) => set({ labels: labels.slice(0, 10) })}
          searchLabel="Search labels"
        />
        <PullRequestFilterRadioSubmenu
          label="Milestone"
          value={filters.milestone ?? ANY}
          options={milestoneOptions}
          onChange={(milestone) => set({ milestone: orUndefined(milestone) })}
        />
        <PullRequestSearchableFilterSubmenu
          label="Parent"
          value={filters.parent ?? ANY}
          options={parentOptions}
          onChange={(parent) => set({ parent: orUndefined(parent) })}
          searchLabel="Search parents"
        />
        <PullRequestFilterRadioSubmenu
          label="Linked"
          value={filters.linked ?? ANY}
          options={LINKED_OPTIONS}
          onChange={(linked) =>
            set({ linked: linked === "linked" || linked === "unlinked" ? linked : undefined })
          }
        />
        {filterCount > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                onFilters(() => ({}));
                if (state !== "open") onState("open");
              }}
            >
              Clear filters
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Any of several computed statuses; unset shows every one. */
function IssueStatusFilter({
  value,
  onChange,
}: {
  value: ReadonlyArray<IssueStatus>;
  onChange: (statuses: ReadonlyArray<IssueStatus>) => void;
}) {
  const only = value.length === 1 ? value[0] : undefined;
  return (
    <MenuSub>
      <MenuSubTrigger>
        {only ? (
          <IssueStatusGlyph status={only} className="size-3.5" />
        ) : (
          <CircleDotDashedIcon aria-hidden className="size-3.5" />
        )}
        <span className="flex-1">Status</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {only
            ? ISSUE_STATUS_PRESENTATION[only].label
            : value.length === 0
              ? "Any"
              : `${value.length} selected`}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        {ISSUE_STATUSES.map((status) => (
          <MenuCheckboxItem
            key={status}
            checked={value.includes(status)}
            closeOnClick={false}
            onCheckedChange={(next) => {
              const others = value.filter((candidate) => candidate !== status);
              onChange(next ? [...others, status] : others);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <IssueStatusGlyph status={status} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                {ISSUE_STATUS_PRESENTATION[status].label}
              </span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The Sort button, shaped like the pull request list's. */
export function IssueSortMenu<Value extends IssueListSort>({
  value,
  options,
  onChange,
}: {
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (sort: Value) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Sort Issues: ${current?.label ?? ""}`}
        render={<Button variant="outline" />}
      >
        <ArrowDownUpIcon aria-hidden className="size-4" />
        <span>Sort</span>
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <PullRequestFilterRadioGroup
          label="Sort by"
          value={value}
          options={options}
          onChange={onChange}
        />
      </MenuPopup>
    </Menu>
  );
}
