import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
  SourceControlProviderKind,
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
  ListFilterIcon,
  LoaderIcon,
  SearchIcon,
} from "lucide-react";
import type { ElementType } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { ProjectFavicon } from "../ProjectFavicon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";

import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export interface PullRequestFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /**
   * Carries the option's own tone, so an icon reads the same here as it does on a row. Left
   * uncoloured, which lets the item's selected state stay the thing the eye follows.
   */
  readonly Icon: ElementType<{ className?: string }>;
  /** Why it cannot be chosen, carried onto the item as its title. */
  readonly unavailable?: string | undefined;
}

export interface PullRequestExpectedHost {
  readonly host: string;
  readonly kind: SourceControlProviderKind;
}

/**
 * What to call a host in the row. The provider's own name reads best — "GitHub" over
 * "github.com" — but it stops naming anything once a workspace has two hosts of one kind, so
 * those wear the host itself instead. Only the ambiguous ones: a lone GitLab beside two GitHub
 * installs is still "GitLab".
 */
export function pullRequestHostLabel(
  entries: ReadonlyArray<{ readonly host: string; readonly kind: SourceControlProviderKind }>,
  entry: { readonly host: string; readonly kind: SourceControlProviderKind },
): string {
  const sharing = entries.filter((candidate) => candidate.kind === entry.kind);
  return sharing.length > 1
    ? entry.host
    : getSourceControlPresentationForKind(entry.kind).providerName;
}

export function PullRequestSearchInput({
  value,
  busy,
  onChange,
}: {
  value: string;
  /** A search is on its way to the hosts, said where the typing is rather than over the list. */
  busy?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
      <InputGroupAddon>
        {busy ? <LoaderIcon aria-hidden className="animate-spin" /> : <SearchIcon aria-hidden />}
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search pull requests, or label:bug"
        aria-label="Search pull requests"
      />
    </InputGroup>
  );
}

/**
 * Every list filter lives behind the one filter icon so the control row stays two controls
 * wide: the search and this. The trigger carries a dot whenever any filter is off its
 * default, so a narrowed list is never a mystery. Same menu chrome as the detail panel's
 * actions, which also owns its own spacing.
 */
const ALL_PROJECTS_VALUE = "all";
/** MenuRadioGroup wants a string, so "every host" wears the one value no host can be. */
const ALL_HOSTS_VALUE = "";
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

function PullRequestFilterRadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  return (
    <MenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (next !== value) onChange(next as Value);
      }}
    >
      <MenuGroupLabel>{label}</MenuGroupLabel>
      {options.map((option) => (
        <MenuRadioItem
          key={option.value}
          value={option.value}
          // A host the server has already said it cannot read is not a choice here: offering
          // it would answer the press by replacing a working list with that failure.
          disabled={option.unavailable !== undefined}
          title={option.unavailable}
        >
          <span className="flex min-w-0 items-center gap-2">
            <option.Icon aria-hidden className="size-3.5" />
            {option.label}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

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
    <Menu>
      <MenuTrigger
        className={cn(
          // The icon-button size that pairs with a full-height input, so the two read as one strip.
          "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:size-8",
          filtered && "text-foreground",
        )}
        aria-label="Filter pull requests"
      >
        <ListFilterIcon className="size-4" />
        {filtered ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-56">
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
        <MenuSeparator />
        <PullRequestFilterRadioGroup
          label="Draft"
          value={filters.draft ?? UNFILTERED_VALUE}
          options={DRAFT_OPTIONS}
          onChange={(next) => onFilters(withFilter("draft", next))}
        />
        <MenuSeparator />
        <PullRequestFilterRadioGroup
          label="Review"
          value={filters.review ?? UNFILTERED_VALUE}
          options={REVIEW_OPTIONS}
          onChange={(next) => onFilters(withFilter("review", next))}
        />
        <MenuSeparator />
        <PullRequestFilterRadioGroup
          label="Checks"
          value={filters.checks ?? UNFILTERED_VALUE}
          options={CHECKS_OPTIONS}
          onChange={(next) => onFilters(withFilter("checks", next))}
        />
        {hostOptions.length > 2 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioGroup
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
            <PullRequestFilterRadioGroup
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
              return (
                <MenuRadioItem
                  key={pullRequestProjectKey(project)}
                  value={pullRequestProjectKey(project)}
                  disabled={reason !== undefined}
                  title={reason}
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
            })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
