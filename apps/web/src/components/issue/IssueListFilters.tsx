import type {
  IssueListOrder,
  IssueListSort,
  IssueCapabilities,
  IssueListEntry,
  IssueListState,
  IssueInvolvement,
} from "@t3tools/contracts";
import { ArrowDownUpIcon, ListFilterIcon } from "lucide-react";
import {
  PullRequestFilterRadioGroup,
  type PullRequestFilterOption,
} from "../pullRequest/PullRequestListFilters";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
const SORT_LABELS: Record<IssueListSort, string> = {
  updated: "Recently updated",
  created: "Newest",
  comments: "Most commented",
};

export function IssueFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  project,
  projectOptions,
  onProject,
  tracker,
  trackerOptions,
  onTracker,
  sorts,
  sort,
  order,
  orders,
  onSort,
  onOrder,
}: {
  state: IssueListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<IssueListState>>;
  onState: (state: IssueListState) => void;
  involvement: IssueInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<IssueInvolvement>>;
  onInvolvement: (involvement: IssueInvolvement) => void;
  project: string;
  projectOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onProject: (project: string) => void;
  tracker: string;
  trackerOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onTracker: (tracker: string) => void;
  sorts: ReadonlyArray<IssueListSort>;
  sort: IssueListSort;
  order: IssueListOrder;
  orders: ReadonlyArray<IssueListOrder>;
  onSort: (sort: IssueListSort) => void;
  onOrder: (order: IssueListOrder) => void;
}) {
  const count = [
    state !== "open",
    involvement !== "all",
    project,
    tracker,
    sort !== "updated",
    order !== "desc",
  ].filter(Boolean).length;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" aria-label="Filters" />}>
        <ListFilterIcon aria-hidden className="size-4" />
        Filters
        {count > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <PullRequestFilterRadioGroup
          label="State"
          value={state}
          options={stateOptions}
          onChange={onState}
        />
        <MenuSeparator />
        <PullRequestFilterRadioGroup
          label="Involvement"
          value={involvement}
          options={involvementOptions}
          onChange={onInvolvement}
        />
        {projectOptions.length > 2 || project ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioGroup
              label="Project"
              value={project}
              options={projectOptions}
              onChange={onProject}
            />
          </>
        ) : null}
        {trackerOptions.length > 2 || tracker ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioGroup
              label="Tracker"
              value={tracker}
              options={trackerOptions}
              onChange={onTracker}
            />
          </>
        ) : null}
        {sorts.length > 1 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioGroup
              label="Sort"
              value={sort}
              options={sorts.map((value) => ({
                value,
                label: SORT_LABELS[value],
                Icon: ArrowDownUpIcon,
              }))}
              onChange={onSort}
            />
          </>
        ) : null}
        {orders.length > 1 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioGroup
              label="Order"
              value={order}
              options={orders.map((value) => ({
                value,
                label: value === "desc" ? "Descending" : "Ascending",
                Icon: ArrowDownUpIcon,
              }))}
              onChange={onOrder}
            />
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function issueSortOptions(
  trackers: ReadonlyArray<{
    readonly configured?: boolean | undefined;
    readonly capabilities?: Pick<IssueCapabilities, "listSorts" | "listOrders"> | null | undefined;
  }>,
) {
  const active = trackers.filter((tracker) => tracker.configured !== false);
  const sources = active.length === 0 ? [{}] : active;
  return {
    sorts: (["updated", "created", "comments"] as IssueListSort[]).filter((sort) =>
      sources.every(
        (tracker) => tracker.capabilities?.listSorts?.includes(sort) ?? sort === "updated",
      ),
    ),
    orders: (["desc", "asc"] as IssueListOrder[]).filter((order) =>
      sources.every(
        (tracker) => tracker.capabilities?.listOrders?.includes(order) ?? order === "desc",
      ),
    ),
  };
}

export function supportedIssueSort(
  sort: IssueListSort | undefined,
  order: IssueListOrder | undefined,
  options: ReturnType<typeof issueSortOptions>,
) {
  return {
    sort:
      sort !== undefined && options.sorts.includes(sort) ? sort : (options.sorts[0] ?? "updated"),
    order:
      order !== undefined && options.orders.includes(order) ? order : (options.orders[0] ?? "desc"),
  };
}

export function compareIssueListRows(
  left: Pick<IssueListEntry, "createdAt" | "updatedAt" | "commentCount">,
  right: Pick<IssueListEntry, "createdAt" | "updatedAt" | "commentCount">,
  sort: IssueListSort,
  order: IssueListOrder,
): number {
  const difference =
    sort === "comments"
      ? (left.commentCount ?? 0) - (right.commentCount ?? 0)
      : Date.parse(sort === "created" ? left.createdAt : left.updatedAt) -
        Date.parse(sort === "created" ? right.createdAt : right.updatedAt);
  return order === "asc" ? difference : -difference;
}
