import { Spinner } from "~/components/ui/spinner";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestFilterOptionsInput,
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
  LayersIcon,
  ListFilterIcon,
  SearchIcon,
  TagIcon,
  UserRoundIcon,
} from "lucide-react";
import { type ElementType, useState } from "react";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { useDebouncedValue } from "~/state/queries";
import { type EnvironmentQueryTarget, usePullRequestFilterOptions } from "~/state/pullRequests";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Button } from "../ui/button";

import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  pullRequestAuthorChoices,
  selectedPullRequestAuthor,
  pullRequestLabelChoices,
  pullRequestLabelColor,
  type PullRequestAuthorFacet,
  type PullRequestLabelFacet,
} from "./pullRequestList.logic";
import { PullRequestActorAvatar } from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import { type AssignableProject, repositoryKey } from "./pullRequestProjectAssignment.logic";

export interface PullRequestFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly Icon: ElementType<{ className?: string }>;
  readonly project?: ProjectFaviconProject;
  readonly unavailable?: string | undefined;
}

export function PullRequestFilterOptionIcon<Value extends string>({
  option,
}: {
  option: PullRequestFilterOption<Value>;
}) {
  return option.project ? (
    <ProjectFavicon project={option.project} className="size-3.5" />
  ) : (
    <option.Icon aria-hidden className="size-3.5" />
  );
}

export interface PullRequestExpectedHost {
  readonly host: string;
  readonly kind: SourceControlProviderKind;
}

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
  onSubmit,
}: {
  value: string;
  busy?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
      <InputGroupAddon>
        {busy ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={draft ?? value}
        onFocus={() => setDraft(value)}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          onChange(event.currentTarget.value);
          if ((event.nativeEvent as InputEvent).inputType === "insertFromPaste") {
            onSubmit(event.currentTarget.value);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            onSubmit(event.currentTarget.value);
          }
        }}
        placeholder="Search pull requests, or label:bug"
        aria-label="Search pull requests"
      />
    </InputGroup>
  );
}

const ALL_PROJECTS_VALUE = "all";
const ALL_HOSTS_VALUE = "";
const ALL_SERVERS_VALUE = "";
const UNFILTERED_VALUE = "all";
/** Project ids are unique only within an environment. */
export const pullRequestProjectKey = (project: {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}) => JSON.stringify([project.environmentId, project.id]);

const DRAFT_OPTIONS = [
  { value: UNFILTERED_VALUE, label: "All", Icon: LayersIcon },
  { value: "only", label: "Drafts only", Icon: PullRequestGlyph.draft },
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
      {options.map((option) => {
        const item = (
          <MenuRadioItem
            key={option.value}
            value={option.value}
            className={option.unavailable ? "data-disabled:pointer-events-auto" : undefined}
            disabled={option.unavailable !== undefined}
          >
            <span className="flex min-w-0 items-center gap-2">
              <PullRequestFilterOptionIcon option={option} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.unavailable ? <span className="shrink-0">· Unavailable</span> : null}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        );
        if (!option.unavailable) return item;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={item} />
            <TooltipPopup side="top">{option.unavailable}</TooltipPopup>
          </Tooltip>
        );
      })}
    </MenuRadioGroup>
  );
}

function PullRequestFilterRadioSubmenu<Value extends string>({
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
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <PullRequestFilterOptionIcon option={current} />
        <span className="flex-1">{label}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {current.label}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestFilterRadioGroup
          label={label}
          value={value}
          options={options}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The listing's own scope, which the pickers search the host within. */
export type PullRequestFilterOptionScope = EnvironmentQueryTarget<
  Omit<PullRequestFilterOptionsInput, "kind" | "query">
>;

const OPTION_SEARCH_DEBOUNCE_MS = 250;

function useHostedFilterOptions(
  scope: ReadonlyArray<PullRequestFilterOptionScope>,
  kind: PullRequestFilterOptionsInput["kind"],
  query: string,
) {
  const typed = query.trim().slice(0, 100);
  const sent = useDebouncedValue(typed, OPTION_SEARCH_DEBOUNCE_MS);
  const hosted = usePullRequestFilterOptions(
    scope.map(({ environmentId, input }) => ({
      environmentId,
      input: { ...input, kind, ...(sent ? { query: sent } : {}) },
    })),
  );
  // Until the search catches up with the typing, the host's answers are for older text.
  return sent === typed ? hosted : { labels: [], authors: [], error: null, isPending: true };
}

/**
 * Whether a submenu's picks narrow to or drop their matches. A pick on either side decides; the
 * switch only matters while nothing is picked.
 */
function useExcluding(included: boolean, excluded: boolean) {
  const [preferExcluding, setPreferExcluding] = useState(excluded);
  return [excluded || (!included && preferExcluding), setPreferExcluding] as const;
}

function PullRequestExcludeSwitch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <>
      <MenuCheckboxItem variant="switch" checked={checked} onCheckedChange={onCheckedChange}>
        Exclude matches
      </MenuCheckboxItem>
      <MenuSeparator />
    </>
  );
}

function excludedSummary(names: ReadonlyArray<string>) {
  return names.length === 1 ? `Not ${names[0]}` : `${names.length} excluded`;
}

export interface PullRequestAuthorSelection {
  readonly author?: string | undefined;
  readonly excludedAuthors?: ReadonlyArray<string> | undefined;
}

function PullRequestAuthorChoices({
  value,
  options,
  scope,
  onChange,
}: {
  value: PullRequestAuthorSelection;
  options: ReadonlyArray<PullRequestAuthorFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (next: PullRequestAuthorSelection) => void;
}) {
  const excluded = value.excludedAuthors ?? [];
  const [excluding, setExcluding] = useExcluding(value.author !== undefined, excluded.length > 0);
  const [query, setQuery] = useState("");
  const hosted = useHostedFilterOptions(scope, "authors", query);
  const picked = excluding ? excluded : value.author === undefined ? [] : [value.author];
  const pickedLogins = new Set(picked.map((login) => login.toLowerCase()));
  const visible = [
    ...picked.flatMap((login) => selectedPullRequestAuthor(options, hosted.authors, login) ?? []),
    ...pullRequestAuthorChoices(options, hosted.authors, query).filter(
      (option) => !pickedLogins.has(option.actor.login.toLowerCase()),
    ),
  ].slice(0, 30);
  const toggleExcluding = (next: boolean) => {
    setExcluding(next);
    if (next && value.author !== undefined) onChange({ excludedAuthors: [value.author] });
    if (!next && excluded.length > 0) onChange({ author: excluded[0] });
  };
  const row = (option: PullRequestAuthorFacet) => (
    <span className="flex min-w-0 items-center gap-2">
      <PullRequestActorAvatar actor={option.actor} />
      <span className="min-w-0 flex-1 truncate">{option.actor.login}</span>
      {option.mergedCount > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {option.mergedCount} merges loaded
        </span>
      ) : null}
    </span>
  );
  const empty =
    visible.length === 0 && !hosted.isPending ? (
      <MenuItem disabled>
        {hosted.error === null ? "No authors found" : "Couldn't search authors on the host"}
      </MenuItem>
    ) : null;
  return (
    <>
      <PullRequestExcludeSwitch checked={excluding} onCheckedChange={toggleExcluding} />
      <MenuSearchInput
        autoFocus
        busy={hosted.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search authors"
        aria-label="Search authors"
      />
      {excluding ? (
        <>
          {visible.map((option) => {
            const login = option.actor.login;
            return (
              <MenuCheckboxItem
                key={login.toLowerCase()}
                checked={pickedLogins.has(login.toLowerCase())}
                onCheckedChange={(next) =>
                  onChange({
                    excludedAuthors: next
                      ? [...excluded, login].slice(0, 10)
                      : excluded.filter((held) => held.toLowerCase() !== login.toLowerCase()),
                  })
                }
              >
                {row(option)}
              </MenuCheckboxItem>
            );
          })}
          {empty}
        </>
      ) : (
        <MenuRadioGroup
          value={visible[0] && value.author !== undefined ? visible[0].actor.login : ""}
          onValueChange={(next: string) => {
            if (next.toLowerCase() !== (value.author?.toLowerCase() ?? ""))
              onChange({ author: next || undefined });
          }}
        >
          <MenuRadioItem value="">
            <span className="flex min-w-0 items-center gap-2">
              <LayersIcon aria-hidden className="size-3.5" />
              Anyone
            </span>
          </MenuRadioItem>
          {visible.map((option) => (
            <MenuRadioItem key={option.actor.login.toLowerCase()} value={option.actor.login}>
              {row(option)}
            </MenuRadioItem>
          ))}
          {empty}
        </MenuRadioGroup>
      )}
    </>
  );
}

function PullRequestAuthorFilter({
  value,
  options,
  scope,
  onChange,
}: {
  value: PullRequestAuthorSelection;
  options: ReadonlyArray<PullRequestAuthorFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (next: PullRequestAuthorSelection) => void;
}) {
  const excluded = value.excludedAuthors ?? [];
  return (
    <MenuSub>
      <MenuSubTrigger>
        <UserRoundIcon aria-hidden className="size-3.5" />
        <span className="flex-1">Author</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {excluded.length > 0 ? excludedSummary(excluded) : (value.author ?? "Anyone")}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestAuthorChoices
          value={value}
          options={options}
          scope={scope}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

export interface PullRequestLabelSelection {
  readonly labels: ReadonlyArray<string>;
  readonly excludedLabels: ReadonlyArray<string>;
}

function PullRequestLabelChoices({
  value,
  options,
  scope,
  onChange,
}: {
  value: PullRequestLabelSelection;
  options: ReadonlyArray<PullRequestLabelFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (next: PullRequestLabelSelection) => void;
}) {
  const [excluding, setExcluding] = useExcluding(
    value.labels.length > 0,
    value.excludedLabels.length > 0,
  );
  const [query, setQuery] = useState("");
  const hosted = useHostedFilterOptions(scope, "labels", query);
  const picked = excluding ? value.excludedLabels : value.labels;
  const pick = (labels: ReadonlyArray<string>) =>
    onChange(excluding ? { labels: [], excludedLabels: labels } : { labels, excludedLabels: [] });
  const selected = new Set(picked.map((name) => name.toLowerCase()));
  const choices = pullRequestLabelChoices(options, hosted.labels, query);
  const visible = [
    ...picked
      .filter((name) => !choices.some((option) => option.name.toLowerCase() === name.toLowerCase()))
      .map((name) => ({ name, color: null, count: 0 })),
    ...choices,
  ];
  return (
    <>
      <PullRequestExcludeSwitch
        checked={excluding}
        onCheckedChange={(next) => {
          setExcluding(next);
          if (picked.length > 0)
            onChange(
              next
                ? { labels: [], excludedLabels: picked }
                : { labels: picked, excludedLabels: [] },
            );
        }}
      />
      <MenuSearchInput
        autoFocus
        busy={hosted.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search labels"
        aria-label="Search labels"
      />
      {visible.length === 0 && !hosted.isPending ? (
        <MenuItem disabled>
          {hosted.error === null ? "No labels found" : "Couldn't search labels on the host"}
        </MenuItem>
      ) : null}
      {visible.map((option) => {
        const key = option.name.toLowerCase();
        const dot = pullRequestLabelColor(option.color);
        return (
          <MenuCheckboxItem
            key={key}
            checked={selected.has(key)}
            onCheckedChange={(next) =>
              pick(
                next
                  ? [...picked, option.name].slice(0, 10)
                  : picked.filter((name) => name.toLowerCase() !== key),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
                {...(dot ? { style: { backgroundColor: dot } } : {})}
              />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.count > 0 ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {option.count}
                </span>
              ) : null}
            </span>
          </MenuCheckboxItem>
        );
      })}
    </>
  );
}

function PullRequestLabelFilter({
  value,
  options,
  scope,
  onChange,
}: {
  value: PullRequestLabelSelection;
  options: ReadonlyArray<PullRequestLabelFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (next: PullRequestLabelSelection) => void;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <TagIcon aria-hidden className="size-3.5" />
        <span className="flex-1">Labels</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {value.excludedLabels.length > 0
            ? excludedSummary(value.excludedLabels)
            : value.labels.length === 0
              ? "Any"
              : `${value.labels.length} selected`}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestLabelChoices
          value={value}
          options={options}
          scope={scope}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

function PullRequestExcludableRadioChoices<Value extends string>({
  label,
  value,
  excluded,
  options,
  onChange,
}: {
  label: string;
  value: Value | undefined;
  excluded: Value | undefined;
  options: ReadonlyArray<PullRequestFilterOption<Value | typeof UNFILTERED_VALUE>>;
  onChange: (next: { readonly value?: Value; readonly excluded?: Value }) => void;
}) {
  const [excluding, setExcluding] = useExcluding(value !== undefined, excluded !== undefined);
  const picked = excluding ? excluded : value;
  return (
    <>
      <PullRequestExcludeSwitch
        checked={excluding}
        onCheckedChange={(next) => {
          setExcluding(next);
          if (picked !== undefined) onChange(next ? { excluded: picked } : { value: picked });
        }}
      />
      <PullRequestFilterRadioGroup
        label={label}
        value={picked ?? UNFILTERED_VALUE}
        options={options}
        onChange={(next) => {
          const chosen = next === UNFILTERED_VALUE ? undefined : (next as Value);
          onChange(
            chosen === undefined ? {} : excluding ? { excluded: chosen } : { value: chosen },
          );
        }}
      />
    </>
  );
}

function PullRequestExcludableRadioSubmenu<Value extends string>({
  label,
  value,
  excluded,
  options,
  onChange,
}: {
  label: string;
  value: Value | undefined;
  excluded: Value | undefined;
  options: ReadonlyArray<PullRequestFilterOption<Value | typeof UNFILTERED_VALUE>>;
  onChange: (next: { readonly value?: Value; readonly excluded?: Value }) => void;
}) {
  const current =
    options.find((option) => option.value === (excluded ?? value ?? UNFILTERED_VALUE)) ??
    options[0];
  if (!current) return null;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <PullRequestFilterOptionIcon option={current} />
        <span className="flex-1">{label}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {excluded === undefined ? current.label : `Not ${current.label.toLowerCase()}`}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <PullRequestExcludableRadioChoices
          label={label}
          value={value}
          excluded={excluded}
          options={options}
          onChange={onChange}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

type PullRequestFilterProject = ProjectFaviconProject & AssignableProject;

function PullRequestProjectChoices({
  projects,
  options,
  value,
  excludedRepositories,
  onChange,
}: {
  projects: ReadonlyArray<PullRequestFilterProject>;
  options: ReadonlyArray<PullRequestFilterOption<string>>;
  value: string;
  excludedRepositories: ReadonlyArray<string>;
  onChange: (next: { value: string; excludedRepositories: ReadonlyArray<string> }) => void;
}) {
  const byRepository = new Map<string, PullRequestFilterProject>();
  for (const project of projects) {
    const key = repositoryKey(project);
    if (key && !byRepository.has(key)) byRepository.set(key, project);
  }
  const chosen = projects.find((project) => pullRequestProjectKey(project) === value);
  const [excluding, setExcluding] = useExcluding(
    chosen !== undefined,
    excludedRepositories.length > 0,
  );
  const excluded = new Set(excludedRepositories);
  const toggleExcluding = (next: boolean) => {
    setExcluding(next);
    const chosenKey = chosen === undefined ? undefined : repositoryKey(chosen);
    if (next && chosenKey !== undefined) {
      onChange({ value: ALL_PROJECTS_VALUE, excludedRepositories: [chosenKey] });
    }
    if (!next && excludedRepositories.length > 0) {
      const first = excludedRepositories
        .map((key) => byRepository.get(key))
        .find((project) => project !== undefined);
      onChange({
        value: first === undefined ? ALL_PROJECTS_VALUE : pullRequestProjectKey(first),
        excludedRepositories: [],
      });
    }
  };
  return (
    <>
      <PullRequestExcludeSwitch checked={excluding} onCheckedChange={toggleExcluding} />
      {excluding ? (
        <MenuGroup>
          <MenuGroupLabel>Project</MenuGroupLabel>
          {[...byRepository].map(([key, project]) => (
            <MenuCheckboxItem
              key={key}
              checked={excluded.has(key)}
              onCheckedChange={(next) =>
                onChange({
                  value: ALL_PROJECTS_VALUE,
                  excludedRepositories: next
                    ? [...excludedRepositories, key]
                    : excludedRepositories.filter((held) => held !== key),
                })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProjectFavicon project={project} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{project.title}</span>
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
      ) : (
        <PullRequestFilterRadioGroup
          label="Project"
          value={value}
          options={options}
          onChange={(next) => onChange({ value: next, excludedRepositories: [] })}
        />
      )}
    </>
  );
}

export function PullRequestFiltersMenu({
  onOpenChange,
  state,
  stateOptions,
  onState,
  involvement,
  involvementOptions,
  onInvolvement,
  filters,
  onFilters,
  authorOptions = [],
  labelOptions = [],
  optionScope,
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
  excludedRepositories,
  onProjectScope,
}: {
  onOpenChange?: (open: boolean) => void;
  state: PullRequestListState;
  stateOptions: ReadonlyArray<PullRequestFilterOption<PullRequestListState>>;
  onState: (state: PullRequestListState) => void;
  involvement: PullRequestInvolvement;
  involvementOptions: ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  filters: PullRequestListFilters;
  onFilters: (filters: PullRequestListFilters) => void;
  authorOptions?: ReadonlyArray<PullRequestAuthorFacet>;
  labelOptions?: ReadonlyArray<PullRequestLabelFacet>;
  optionScope: ReadonlyArray<PullRequestFilterOptionScope>;
  host: string | undefined;
  hostOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onHost: (host: string | undefined) => void;
  server: EnvironmentId | undefined;
  serverOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onServer: (server: EnvironmentId | undefined) => void;
  projects: ReadonlyArray<PullRequestFilterProject>;
  projectId: ProjectId | undefined;
  projectEnvironmentId: EnvironmentId | undefined;
  unavailable: ReadonlyMap<string, string>;
  excludedRepositories: ReadonlyArray<string>;
  onProjectScope: (next: {
    readonly project: PullRequestFilterProject | undefined;
    readonly excludedRepositories: ReadonlyArray<string>;
  }) => void;
}) {
  const shownRepositoryKeys = new Set(projects.map(repositoryKey));
  const excludedRepositoryCount =
    projectId === undefined
      ? excludedRepositories.filter((key) => shownRepositoryKeys.has(key)).length
      : 0;
  const selectedLabels = (filters.labels ?? []).flatMap((group) => group);
  const filterCount =
    [
      state !== "open",
      involvement !== "all",
      host,
      server,
      projectId,
      filters.draft,
      filters.review,
      filters.excludedReview,
      filters.checks,
      filters.excludedChecks,
      filters.author,
      ...(filters.excludedAuthors ?? []),
      ...selectedLabels,
      ...(filters.excludedLabels ?? []),
    ].filter(Boolean).length + excludedRepositoryCount;
  const updateFilters = (next: Partial<PullRequestListFilters>) =>
    onFilters(
      Object.fromEntries(
        Object.entries({ ...filters, ...next }).filter(([, value]) => value !== undefined),
      ) as PullRequestListFilters,
    );

  const projectValue =
    projectId === undefined || projectEnvironmentId === undefined
      ? ALL_PROJECTS_VALUE
      : pullRequestProjectKey({ id: projectId, environmentId: projectEnvironmentId });
  const projectOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: ALL_PROJECTS_VALUE, label: "All projects", Icon: LayersIcon },
    ...projects
      .toSorted(
        (left, right) =>
          Number(unavailable.has(pullRequestProjectKey(left))) -
          Number(unavailable.has(pullRequestProjectKey(right))),
      )
      .map((project) => ({
        value: pullRequestProjectKey(project),
        label: project.title,
        Icon: FolderGit2Icon,
        project,
        ...(unavailable.has(pullRequestProjectKey(project))
          ? { unavailable: unavailable.get(pullRequestProjectKey(project)) }
          : {}),
      })),
  ];
  return (
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger render={<Button variant="outline" />}>
        <ListFilterIcon className="size-4" />
        <span>Filters</span>
        {filterCount > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {filterCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label="State"
          value={state}
          options={stateOptions}
          onChange={onState}
        />
        <PullRequestFilterRadioSubmenu
          label="Involvement"
          value={involvement}
          options={involvementOptions}
          onChange={onInvolvement}
        />
        <MenuSeparator />
        <PullRequestAuthorFilter
          value={{ author: filters.author, excludedAuthors: filters.excludedAuthors }}
          options={authorOptions}
          scope={optionScope}
          onChange={(next) =>
            updateFilters({
              author: next.author,
              excludedAuthors: next.excludedAuthors?.length ? next.excludedAuthors : undefined,
            })
          }
        />
        <PullRequestLabelFilter
          value={{ labels: selectedLabels, excludedLabels: filters.excludedLabels ?? [] }}
          options={labelOptions}
          scope={optionScope}
          onChange={(next) =>
            updateFilters({
              labels: next.labels.length === 0 ? undefined : next.labels.map((label) => [label]),
              excludedLabels: next.excludedLabels.length === 0 ? undefined : next.excludedLabels,
            })
          }
        />
        <PullRequestFilterRadioSubmenu
          label="Draft"
          value={filters.draft ?? UNFILTERED_VALUE}
          options={DRAFT_OPTIONS}
          onChange={(draft) =>
            updateFilters({ draft: draft === UNFILTERED_VALUE ? undefined : draft })
          }
        />
        <PullRequestExcludableRadioSubmenu
          label="Review"
          value={filters.review}
          excluded={filters.excludedReview}
          options={REVIEW_OPTIONS}
          onChange={(next) => updateFilters({ review: next.value, excludedReview: next.excluded })}
        />
        <PullRequestExcludableRadioSubmenu
          label="Checks"
          value={filters.checks}
          excluded={filters.excludedChecks}
          options={CHECKS_OPTIONS}
          onChange={(next) => updateFilters({ checks: next.value, excludedChecks: next.excluded })}
        />
        {hostOptions.length > 2 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioSubmenu
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
            <PullRequestFilterRadioSubmenu
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
        <MenuSub>
          <MenuSubTrigger>
            <FolderGit2Icon aria-hidden className="size-3.5" />
            <span className="flex-1">Project</span>
            <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
              {excludedRepositoryCount > 0
                ? excludedSummary(
                    projects
                      .filter((project) =>
                        excludedRepositories.includes(repositoryKey(project) ?? ""),
                      )
                      .map((project) => project.title)
                      .filter((title, index, titles) => titles.indexOf(title) === index),
                  )
                : (projectOptions.find((option) => option.value === projectValue)?.label ??
                  "All projects")}
            </span>
          </MenuSubTrigger>
          <MenuSubPopup>
            <PullRequestProjectChoices
              projects={projects}
              options={projectOptions}
              value={projectValue}
              excludedRepositories={projectId === undefined ? excludedRepositories : []}
              onChange={(next) =>
                onProjectScope({
                  project: projects.find(
                    (candidate) => pullRequestProjectKey(candidate) === next.value,
                  ),
                  excludedRepositories: next.excludedRepositories,
                })
              }
            />
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>
  );
}
