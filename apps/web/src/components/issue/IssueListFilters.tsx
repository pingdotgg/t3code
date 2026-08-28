import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueListState,
  ProjectId,
} from "@t3tools/contracts";
import { ArrowDownUpIcon, SettingsIcon, TagIcon, TagsIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import {
  ALL_HOSTS_VALUE,
  ListFilterMenu,
  ListFilterRadioGroup,
  ListProjectFilterGroup,
  type ListFilterOption,
} from "../sourceControl/ListFilterMenu";
import { LinearIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
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
    <MenuRadioGroup value={value} onValueChange={onChange}>
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
}: {
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
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  className="relative"
                  size="icon"
                  variant="outline"
                  aria-label="Sort issues"
                />
              }
            />
          }
        >
          <ArrowDownUpIcon className="size-4" />
          {sort !== "updated" || order !== "desc" ? (
            <span
              aria-hidden
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">Sort issues</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <MenuRadioGroup value={sort} onValueChange={chooseSort}>
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          <MenuRadioItem value="created">Created on</MenuRadioItem>
          <MenuRadioItem value="updated">Last updated</MenuRadioItem>
          <MenuRadioItem value="comments">Total comments</MenuRadioItem>
          <MenuRadioItem value="best-match">Best match</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSub>
          <MenuSubTrigger>Reactions</MenuSubTrigger>
          <MenuSubPopup className="min-w-48">
            <MenuRadioGroup value={sort} onValueChange={chooseSort}>
              {REACTION_SORTS.map(([value, label, emoji]) => (
                <MenuRadioItem key={value} value={value}>
                  <span className="flex items-center gap-2">
                    {emoji ? <span aria-hidden>{emoji}</span> : null}
                    {label}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
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
              <MenuRadioItem value="asc">{ascendingLabel}</MenuRadioItem>
              <MenuRadioItem value="desc">{descendingLabel}</MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function IssueFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  hostFilter,
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
  /**
   * Absent where the caller already knows the host, which is a surface listing one repository:
   * a group offering the only host there is says nothing.
   */
  hostFilter?: {
    readonly host: string | undefined;
    /**
     * Includes the "all hosts" entry, whose value is the empty string. With fewer than two real
     * hosts there is nothing to switch between, so the whole group stays out of the menu.
     */
    readonly hostOptions: ReadonlyArray<ListFilterOption<string>>;
    readonly onHost: (host: string | undefined) => void;
    readonly onManageLinear?: () => void;
    readonly linearManaged?: boolean;
  };
  /** Absent for the same reason `hostFilter` is: one project is not a choice. */
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
  const providerOptions = hostFilter?.hostOptions.filter((option) => !option.unavailable) ?? [];
  const linearOption = providerOptions.find((option) => option.value === "linear.app");
  const linearManaged = hostFilter?.linearManaged ?? linearOption !== undefined;
  const filtered =
    state !== "open" ||
    involvement !== "all" ||
    hostFilter?.host !== undefined ||
    projectFilter?.projectId !== undefined ||
    label !== undefined;
  return (
    <ListFilterMenu label="Filter issues" filtered={filtered}>
      <ListFilterRadioGroup label="State" value={state} options={stateOptions} onChange={onState} />
      <MenuSeparator />
      <ListFilterRadioGroup
        label="Involvement"
        value={involvement}
        options={involvementOptions}
        onChange={onInvolvement}
      />
      {hostFilter !== undefined &&
      (providerOptions.length > 2 || hostFilter.onManageLinear !== undefined) ? (
        <>
          <MenuSeparator />
          {linearOption && hostFilter.onManageLinear ? (
            renderIssueProviderMenuRadioGroup({
              label: "Provider",
              value: hostFilter.host ?? ALL_HOSTS_VALUE,
              options: providerOptions,
              onChange: (next) => {
                if (next !== (hostFilter.host ?? ALL_HOSTS_VALUE)) {
                  hostFilter.onHost(next === ALL_HOSTS_VALUE ? undefined : next);
                }
              },
              onManageLinear: hostFilter.onManageLinear,
            })
          ) : (
            <ListFilterRadioGroup
              label="Provider"
              value={hostFilter.host ?? ALL_HOSTS_VALUE}
              options={providerOptions}
              onChange={(next) => hostFilter.onHost(next === ALL_HOSTS_VALUE ? undefined : next)}
            />
          )}
          {hostFilter.onManageLinear !== undefined && linearOption === undefined ? (
            <MenuItem onClick={hostFilter.onManageLinear}>
              <LinearIcon aria-hidden className="size-3.5" />
              {linearManaged ? "Linear settings…" : "Connect Linear…"}
            </MenuItem>
          ) : null}
        </>
      ) : null}
      {projectFilter === undefined ? null : (
        <>
          <MenuSeparator />
          <ListProjectFilterGroup
            environmentId={projectFilter.environmentId}
            projects={projectFilter.projects}
            projectId={projectFilter.projectId}
            unavailable={projectFilter.unavailable}
            onProject={projectFilter.onProject}
          />
        </>
      )}
      {/* Nothing loaded wears a label: there is no choice to offer, and a lone "All labels"
          row would only say so in the least useful place. */}
      {labels.length > 0 ? (
        <>
          <MenuSeparator />
          <ListFilterRadioGroup
            label="Label"
            value={label ?? ALL_LABELS_VALUE}
            options={[
              { value: ALL_LABELS_VALUE, label: "All labels", Icon: TagsIcon },
              ...labels.map((name) => ({ value: name, label: name, Icon: TagIcon })),
            ]}
            onChange={(next) => onLabel(next === ALL_LABELS_VALUE ? undefined : next)}
          />
        </>
      ) : null}
    </ListFilterMenu>
  );
}
