import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
} from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  EyeOffIcon,
  FolderGit2Icon,
  GitPullRequestDraftIcon,
  LayersIcon,
} from "lucide-react";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  ALL_HOSTS_VALUE,
  ListFilterMenu,
  ListFilterRadioGroup,
  type ListFilterOption,
} from "../sourceControl/ListFilterMenu";
import { MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type PullRequestFilterOption<Value extends string> = ListFilterOption<Value>;

const ALL_PROJECTS_VALUE = "all";
/** The same trick for the servers, which are named by an id no empty string can collide with. */
const ALL_SERVERS_VALUE = "";
/** The unset value of each narrowing group, which no filter of theirs is named after. */
const UNFILTERED_VALUE = "all";
/**
 * A project's own radio value, carrying the server along with the id: the id alone is only
 * unique within its own server, so two rows sharing one would otherwise both read as checked.
 */
export const pullRequestProjectKey = (project: {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}) => JSON.stringify([project.environmentId, project.id]);

const DRAFT_OPTIONS = [
  { value: UNFILTERED_VALUE, label: "All", Icon: LayersIcon },
  { value: "only", label: "Drafts only", Icon: GitPullRequestDraftIcon },
  { value: "hide", label: "Hide drafts", Icon: EyeOffIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const REVIEW_OPTIONS = [
  { value: UNFILTERED_VALUE, label: "All", Icon: LayersIcon },
  { value: "approved", label: "Approved", Icon: CircleCheckIcon },
  { value: "changes-requested", label: "Changes requested", Icon: CircleXIcon },
  { value: "review-required", label: "Review required", Icon: CircleDashedIcon },
  { value: "none", label: "No reviews", Icon: CircleSlashIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const CHECKS_OPTIONS = [
  { value: UNFILTERED_VALUE, label: "All", Icon: LayersIcon },
  { value: "passing", label: "Passing", Icon: CircleCheckIcon },
  { value: "failing", label: "Failing", Icon: CircleXIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

export function PullRequestFiltersMenu({
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  filters,
  onFilters,
  host,
  hostOptions,
  onHost,
  server,
  serverOptions,
  onServer,
  projects,
  projectId,
  projectEnvironmentId,
  unavailable,
  onProject,
}: {
  state: PullRequestListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;
  onState: (state: PullRequestListState) => void;
  involvement: PullRequestInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  /** The narrowings beyond state and involvement; an absent field is that group unfiltered. */
  filters: PullRequestListFilters;
  onFilters: (filters: PullRequestListFilters) => void;
  host: string | undefined;
  /**
   * Includes the "all hosts" entry, whose value is the empty string. With fewer than two real
   * hosts there is nothing to switch between, so the whole group stays out of the menu.
   */
  hostOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onHost: (host: string | undefined) => void;
  server: EnvironmentId | undefined;
  /**
   * Includes the "all servers" entry, whose value is the empty string. With one server there is
   * nothing to switch between, so the whole group stays out of the menu.
   */
  serverOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onServer: (server: EnvironmentId | undefined) => void;
  /** The projects of every connected environment, each carrying the one its favicon is read from. */
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  projectId: ProjectId | undefined;
  /**
   * The server the selected project belongs to. A project id is only unique within its own
   * server, so without this two rows sharing an id would both read as checked here.
   */
  projectEnvironmentId: EnvironmentId | undefined;
  /**
   * Projects whose repository could not be read this time round. They are named here, where
   * the reader is already choosing between projects, rather than as a count above the list
   * that says something is missing without saying which.
   */
  unavailable: ReadonlyMap<string, string>;
  /** The environment comes with the project id, since picking a row picks a specific server's copy of it. */
  onProject: (projectId: ProjectId | undefined, environmentId: EnvironmentId | undefined) => void;
}) {
  const filtered =
    state !== "open" ||
    involvement !== "all" ||
    host !== undefined ||
    server !== undefined ||
    projectId !== undefined ||
    Object.keys(filters).length > 0;
  /**
   * Rebuilt rather than spread so an unfiltered group leaves the record instead of lingering in
   * it as an explicit `undefined`, which the listing input does not accept.
   */
  const withFilter = (key: keyof PullRequestListFilters, value: string): PullRequestListFilters =>
    Object.fromEntries(
      Object.entries({ ...filters, [key]: value === UNFILTERED_VALUE ? undefined : value }).filter(
        ([, held]) => held !== undefined,
      ),
    ) as PullRequestListFilters;
  return (
    <ListFilterMenu label="Filter pull requests" filtered={filtered}>
      <ListFilterRadioGroup label="State" value={state} options={stateOptions} onChange={onState} />
      <MenuSeparator />
      <ListFilterRadioGroup
        label="Involvement"
        value={involvement}
        options={involvementOptions}
        onChange={onInvolvement}
      />
      <MenuSeparator />
      <ListFilterRadioGroup
        label="Draft"
        value={filters.draft ?? UNFILTERED_VALUE}
        options={DRAFT_OPTIONS}
        onChange={(next) => onFilters(withFilter("draft", next))}
      />
      <MenuSeparator />
      <ListFilterRadioGroup
        label="Review"
        value={filters.review ?? UNFILTERED_VALUE}
        options={REVIEW_OPTIONS}
        onChange={(next) => onFilters(withFilter("review", next))}
      />
      <MenuSeparator />
      <ListFilterRadioGroup
        label="Checks"
        value={filters.checks ?? UNFILTERED_VALUE}
        options={CHECKS_OPTIONS}
        onChange={(next) => onFilters(withFilter("checks", next))}
      />
      {hostOptions.length > 2 ? (
        <>
          <MenuSeparator />
          <ListFilterRadioGroup
            label="Host"
            value={host ?? ALL_HOSTS_VALUE}
            options={hostOptions}
            onChange={(next) => onHost(next === ALL_HOSTS_VALUE ? undefined : next)}
          />
        </>
      ) : null}
      {serverOptions.length > 2 ? (
        <>
          <MenuSeparator />
          <ListFilterRadioGroup
            label="Server"
            value={server ?? ALL_SERVERS_VALUE}
            options={serverOptions}
            onChange={(next) =>
              onServer(next === ALL_SERVERS_VALUE ? undefined : (next as EnvironmentId))
            }
          />
        </>
      ) : null}
      <MenuSeparator />
      <MenuRadioGroup
        value={
          projectId === undefined || projectEnvironmentId === undefined
            ? ALL_PROJECTS_VALUE
            : pullRequestProjectKey({ id: projectId, environmentId: projectEnvironmentId })
        }
        onValueChange={(next) => {
          if (next === ALL_PROJECTS_VALUE) {
            if (projectId !== undefined) onProject(undefined, undefined);
            return;
          }
          // The value carries both halves, since the id alone cannot tell two servers' rows
          // apart once they share one.
          const project = projects.find((candidate) => pullRequestProjectKey(candidate) === next);
          if (
            project !== undefined &&
            (project.id !== projectId || project.environmentId !== projectEnvironmentId)
          ) {
            onProject(project.id, project.environmentId);
          }
        }}
      >
        <MenuGroupLabel>Project</MenuGroupLabel>
        <MenuRadioItem value={ALL_PROJECTS_VALUE}>
          <span className="flex min-w-0 items-center gap-2">
            <LayersIcon aria-hidden className="size-3.5" />
            All projects
          </span>
        </MenuRadioItem>
        {/* The ones that can be chosen first: a list that opens with three disabled rows reads
              as a broken menu rather than as a workspace with three unreadable repositories. */}
        {projects
          .toSorted(
            (left, right) =>
              Number(unavailable.has(pullRequestProjectKey(left))) -
              Number(unavailable.has(pullRequestProjectKey(right))),
          )
          .map((project) => {
            const reason = unavailable.get(pullRequestProjectKey(project));
            const item = (
              <MenuRadioItem
                key={pullRequestProjectKey(project)}
                value={pullRequestProjectKey(project)}
                className={reason !== undefined ? "data-disabled:pointer-events-auto" : undefined}
                disabled={reason !== undefined}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <ProjectFavicon
                    environmentId={project.environmentId}
                    cwd={project.workspaceRoot}
                    fallbackIcon={FolderGit2Icon}
                    className="size-3.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  {reason === undefined ? null : (
                    <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400/90">
                      Unavailable
                    </span>
                  )}
                </span>
              </MenuRadioItem>
            );
            if (reason === undefined) return item;
            return (
              <Tooltip key={pullRequestProjectKey(project)}>
                <TooltipTrigger render={item} />
                <TooltipPopup side="top" className="max-w-80">
                  {reason}
                </TooltipPopup>
              </Tooltip>
            );
          })}
      </MenuRadioGroup>
    </ListFilterMenu>
  );
}
