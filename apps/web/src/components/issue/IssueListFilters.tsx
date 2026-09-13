import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueListState,
  ProjectId,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarArrowUpIcon,
  ClockIcon,
  FolderGit2Icon,
  LayersIcon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
  TagIcon,
  TagsIcon,
  ThumbsUpIcon,
} from "lucide-react";

import type { ElementType, ReactNode } from "react";

import { cn } from "~/lib/utils";

import {
  ListFilterMenu,
  ListFilterRadioGroup,
  ListProjectFilterGroup,
  type ListFilterOption,
} from "../sourceControl/ListFilterMenu";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { issueListOrderLabels } from "./issueList.logic";

/** A label name is never empty, so the same trick the hosts use names "every label". */
const ALL_LABELS_VALUE = "";

export function renderIssueProviderMenuRadioGroup({
  label,
  value,
  options,
  onChange,
  onManageLinear,
}: {
  label?: string;
  value: string;
  options: ReadonlyArray<ListFilterOption<string>>;
  onChange: (value: string) => void;
  onManageLinear?: () => void;
}) {
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next);
      }}
    >
      {label ? <MenuGroupLabel>{label}</MenuGroupLabel> : null}
      {options.map((option) => {
        const item = (
          <MenuRadioItem
            key={option.value}
            value={option.value}
            className={cn(
              option.value === "linear.app" && onManageLinear && "min-w-0 flex-1",
              option.unavailable && "data-disabled:pointer-events-auto",
            )}
            disabled={option.unavailable !== undefined}
          >
            <span className="flex min-w-0 items-center gap-2">
              <option.Icon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        );
        const radioItem = option.unavailable ? (
          <Tooltip key={option.value}>
            <TooltipTrigger render={item} />
            <TooltipPopup side="top" className="max-w-80">
              {option.unavailable}
            </TooltipPopup>
          </Tooltip>
        ) : (
          item
        );
        if (option.value !== "linear.app" || !onManageLinear) return radioItem;
        return (
          <div key={option.value} className="flex items-center gap-1">
            {radioItem}
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuItem
                    aria-label="Linear settings"
                    className="size-7 shrink-0 justify-center p-0"
                    onClick={onManageLinear}
                  />
                }
              >
                <SettingsIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">Linear settings</TooltipPopup>
            </Tooltip>
          </div>
        );
      })}
    </MenuRadioGroup>
  );
}

const SORT_OPTIONS = [
  { value: "created", label: "Created on", Icon: CalendarArrowUpIcon },
  { value: "updated", label: "Last updated", Icon: ClockIcon },
  { value: "comments", label: "Total comments", Icon: MessageSquareIcon },
  { value: "best-match", label: "Best match", Icon: SearchIcon },
] as const;

const REACTION_SORTS = [
  ["reactions", "Total reactions", ""],
  ["reactions-thumbs-up", "Thumbs up", "👍"],
  ["reactions-thumbs-down", "Thumbs down", "👎"],
  ["reactions-rocket", "Rocket", "🚀"],
  ["reactions-hooray", "Hooray", "🎉"],
  ["reactions-eyes", "Eyes", "👀"],
  ["reactions-heart", "Heart", "❤️"],
  ["reactions-laugh", "Laugh", "😄"],
  ["reactions-confused", "Confused", "😕"],
] as const satisfies ReadonlyArray<readonly [IssueListSort, string, string]>;

export function IssueSortMenu({
  sort,
  order,
  onSort,
  onOrder,
  reactionsAvailable = true,
}: {
  readonly reactionsAvailable?: boolean;
  readonly sort: IssueListSort;
  readonly order: IssueListOrder;
  readonly onSort: (sort: IssueListSort) => void;
  readonly onOrder: (order: IssueListOrder) => void;
}) {
  const chooseSort = (value: string) => {
    if (value !== sort) onSort(value as IssueListSort);
  };
  const [ascendingLabel, descendingLabel] = issueListOrderLabels(sort);
  return (
    <Menu>
      <MenuTrigger aria-label="Sort issues" render={<Button variant="outline" />}>
        <ArrowDownUpIcon className="size-4" />
        <span>Sort</span>
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <MenuRadioGroup value={sort} onValueChange={chooseSort}>
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          {SORT_OPTIONS.map(({ value, label, Icon }) => (
            <MenuRadioItem key={value} value={value}>
              <span className="flex min-w-0 items-center gap-2">
                <Icon aria-hidden className="size-3.5" />
                <span className="flex-1">{label}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {reactionsAvailable ? (
          <MenuSub>
            <MenuSubTrigger>
              <ThumbsUpIcon aria-hidden className="size-3.5" />
              Reactions
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-48">
              <MenuRadioGroup value={sort} onValueChange={chooseSort}>
                {REACTION_SORTS.map(([value, label, emoji]) => (
                  <MenuRadioItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      {emoji ? <span aria-hidden>{emoji}</span> : null}
                      <span className="flex-1">{label}</span>
                      <MenuRadioItemIndicator />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        {sort !== "best-match" ? (
          <>
            <MenuSeparator />
            <MenuRadioGroup
              value={order}
              onValueChange={(value) => {
                if (value !== order) onOrder(value as IssueListOrder);
              }}
            >
              <MenuGroupLabel>Order</MenuGroupLabel>
              <MenuRadioItem value="asc">
                <span className="flex items-center gap-2">
                  <ArrowUpIcon aria-hidden className="size-3.5" />
                  <span className="flex-1">{ascendingLabel}</span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
              <MenuRadioItem value="desc">
                <span className="flex items-center gap-2">
                  <ArrowDownIcon aria-hidden className="size-3.5" />
                  <span className="flex-1">{descendingLabel}</span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function IssueFilterSubmenu({
  Icon,
  label,
  current,
  children,
}: {
  label: string;
  current: string;
  Icon: ElementType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <Icon aria-hidden className="size-3.5" />
        <span className="flex-1">{label}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">{current}</span>
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-56">{children}</MenuSubPopup>
    </MenuSub>
  );
}

export function IssueFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  projectFilter,
  label,
  labels,
  onLabel,
}: {
  state: IssueListState;
  stateOptions: ReadonlyArray<ListFilterOption<IssueListState>>;
  onState: (state: IssueListState) => void;
  involvement: IssueInvolvement;
  involvementOptions: ReadonlyArray<ListFilterOption<IssueInvolvement>>;
  onInvolvement: (involvement: IssueInvolvement) => void;
  projectFilter?: {
    readonly environmentId: EnvironmentId | null;
    readonly projects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    }>;
    readonly projectId: ProjectId | undefined;
    readonly unavailable: ReadonlyMap<ProjectId, string>;
    readonly onProject: (projectId: ProjectId | undefined) => void;
  };
  label: string | undefined;
  /**
   * The labels the loaded rows actually wear, as names. No host is asked about a label, so this
   * narrows what has already arrived and can only ever offer what is on the page — which is why
   * the caller passes names rather than options: every one of them wears the same icon.
   */
  labels: ReadonlyArray<string>;
  onLabel: (label: string | undefined) => void;
}) {
  const filterCount = [
    state !== "open",
    involvement !== "all",
    projectFilter?.projectId !== undefined,
    label !== undefined,
  ].filter(Boolean).length;
  return (
    <ListFilterMenu label="Filter issues" filterCount={filterCount}>
      <IssueFilterSubmenu
        label="State"
        Icon={stateOptions.find((option) => option.value === state)?.Icon ?? LayersIcon}
        current={stateOptions.find((option) => option.value === state)?.label ?? state}
      >
        <ListFilterRadioGroup
          label="State"
          value={state}
          options={stateOptions}
          onChange={onState}
        />
      </IssueFilterSubmenu>
      <IssueFilterSubmenu
        label="Involvement"
        Icon={involvementOptions.find((option) => option.value === involvement)?.Icon ?? LayersIcon}
        current={
          involvementOptions.find((option) => option.value === involvement)?.label ?? involvement
        }
      >
        <ListFilterRadioGroup
          label="Involvement"
          value={involvement}
          options={involvementOptions}
          onChange={onInvolvement}
        />
      </IssueFilterSubmenu>
      {projectFilter === undefined ? null : (
        <>
          <MenuSeparator />
          <IssueFilterSubmenu
            label="Project"
            Icon={FolderGit2Icon}
            current={
              projectFilter.projects.find((project) => project.id === projectFilter.projectId)
                ?.title ?? "All projects"
            }
          >
            <ListProjectFilterGroup
              environmentId={projectFilter.environmentId}
              projects={projectFilter.projects}
              projectId={projectFilter.projectId}
              unavailable={projectFilter.unavailable}
              onProject={projectFilter.onProject}
            />
          </IssueFilterSubmenu>
        </>
      )}
      {/* Nothing loaded wears a label: there is no choice to offer, and a lone "All labels"
          row would only say so in the least useful place. */}
      {labels.length > 0 ? (
        <>
          <MenuSeparator />
          <IssueFilterSubmenu Icon={TagIcon} label="Label" current={label ?? "All labels"}>
            <ListFilterRadioGroup
              label="Label"
              value={label ?? ALL_LABELS_VALUE}
              options={[
                { value: ALL_LABELS_VALUE, label: "All labels", Icon: TagsIcon },
                ...labels.map((name) => ({ value: name, label: name, Icon: TagIcon })),
              ]}
              onChange={(next) => onLabel(next === ALL_LABELS_VALUE ? undefined : next)}
            />
          </IssueFilterSubmenu>
        </>
      ) : null}
    </ListFilterMenu>
  );
}
