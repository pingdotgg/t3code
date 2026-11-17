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
import { useTranslation } from "react-i18next";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { useDebouncedValue } from "~/state/queries";
import { type EnvironmentQueryTarget, usePullRequestFilterOptions } from "~/state/pullRequests";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Button } from "../ui/button";

import {
  Menu,
  MenuCheckboxItem,
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
  const { t } = useTranslation("pullRequest");
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
        placeholder={t("list.searchPlaceholder")}
        aria-label={t("list.search")}
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
  { value: UNFILTERED_VALUE, label: "list.all", Icon: LayersIcon },
  { value: "only", label: "list.draft.only", Icon: PullRequestGlyph.draft },
  { value: "hide", label: "list.draft.hide", Icon: EyeOffIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const REVIEW_OPTIONS = [
  { value: UNFILTERED_VALUE, label: "list.all", Icon: LayersIcon },
  { value: "approved", label: "list.review.approved", Icon: CircleCheckIcon },
  { value: "changes-requested", label: "list.review.changesRequested", Icon: CircleXIcon },
  { value: "review-required", label: "list.review.reviewRequired", Icon: CircleDashedIcon },
  { value: "none", label: "list.review.none", Icon: CircleSlashIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const CHECKS_OPTIONS = [
  { value: UNFILTERED_VALUE, label: "list.all", Icon: LayersIcon },
  { value: "passing", label: "list.checks.passing", Icon: CircleCheckIcon },
  { value: "failing", label: "list.checks.failing", Icon: CircleXIcon },
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
  const { t } = useTranslation("pullRequest");
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
              <span className="min-w-0 flex-1 truncate">{t(option.label as never)}</span>
              {option.unavailable ? (
                <span className="shrink-0">{t("list.unavailableDot")}</span>
              ) : null}
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
  const { t } = useTranslation("pullRequest");
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <PullRequestFilterOptionIcon option={current} />
        <span className="flex-1">{label}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {t(current.label as never)}
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

function PullRequestAuthorChoices({
  value,
  options,
  scope,
  onChange,
}: {
  value: string | undefined;
  options: ReadonlyArray<PullRequestAuthorFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (author: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const { t } = useTranslation("pullRequest");
  const hosted = useHostedFilterOptions(scope, "authors", query);
  const login = value?.toLowerCase() ?? "";
  const selected = selectedPullRequestAuthor(options, hosted.authors, value);
  const visible = [
    ...(selected ? [selected] : []),
    ...pullRequestAuthorChoices(options, hosted.authors, query).filter(
      (option) => option.actor.login.toLowerCase() !== login,
    ),
  ].slice(0, 30);
  const select = (next: string) => next.toLowerCase() !== login && onChange(next || undefined);
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={hosted.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={t("list.searchAuthors")}
        aria-label={t("list.searchAuthors")}
      />
      <MenuRadioGroup value={selected?.actor.login ?? value ?? ""} onValueChange={select}>
        <MenuRadioItem value="">
          <span className="flex min-w-0 items-center gap-2">
            <LayersIcon aria-hidden className="size-3.5" />
            {t("list.anyone")}
          </span>
        </MenuRadioItem>
        {visible.map((option) => (
          <MenuRadioItem key={option.actor.login.toLowerCase()} value={option.actor.login}>
            <span className="flex min-w-0 items-center gap-2">
              <PullRequestActorAvatar actor={option.actor} />
              <span className="min-w-0 flex-1 truncate">{option.actor.login}</span>
              {option.mergedCount > 0 ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {t("list.mergesLoaded", { count: option.mergedCount })}
                </span>
              ) : null}
            </span>
          </MenuRadioItem>
        ))}
        {visible.length === 0 && !hosted.isPending ? (
          <MenuItem disabled>
            {hosted.error === null ? t("list.noAuthors") : t("list.searchAuthorsFailed")}
          </MenuItem>
        ) : null}
      </MenuRadioGroup>
    </>
  );
}

function PullRequestAuthorFilter({
  value,
  options,
  scope,
  onChange,
}: {
  value: string | undefined;
  options: ReadonlyArray<PullRequestAuthorFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (author: string | undefined) => void;
}) {
  const { t } = useTranslation("pullRequest");
  return (
    <MenuSub>
      <MenuSubTrigger>
        <UserRoundIcon aria-hidden className="size-3.5" />
        <span className="flex-1">{t("list.author")}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {value ?? t("list.anyone")}
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

function PullRequestLabelChoices({
  value,
  options,
  scope,
  onChange,
}: {
  value: ReadonlyArray<string>;
  options: ReadonlyArray<PullRequestLabelFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (labels: ReadonlyArray<string>) => void;
}) {
  const [query, setQuery] = useState("");
  const { t } = useTranslation("pullRequest");
  const hosted = useHostedFilterOptions(scope, "labels", query);
  const selected = new Set(value.map((name) => name.toLowerCase()));
  const choices = pullRequestLabelChoices(options, hosted.labels, query);
  const visible = [
    ...value
      .filter((name) => !choices.some((option) => option.name.toLowerCase() === name.toLowerCase()))
      .map((name) => ({ name, color: null, count: 0 })),
    ...choices,
  ];
  return (
    <>
      <MenuSearchInput
        autoFocus
        busy={hosted.isPending}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={t("list.searchLabels")}
        aria-label={t("list.searchLabels")}
      />
      {visible.length === 0 && !hosted.isPending ? (
        <MenuItem disabled>
          {hosted.error === null ? t("list.noLabels") : t("list.searchLabelsFailed")}
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
              onChange(
                next
                  ? [...value, option.name]
                  : value.filter((name) => name.toLowerCase() !== option.name.toLowerCase()),
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
  value: ReadonlyArray<string>;
  options: ReadonlyArray<PullRequestLabelFacet>;
  scope: ReadonlyArray<PullRequestFilterOptionScope>;
  onChange: (labels: ReadonlyArray<string>) => void;
}) {
  const { t } = useTranslation("pullRequest");
  return (
    <MenuSub>
      <MenuSubTrigger>
        <TagIcon aria-hidden className="size-3.5" />
        <span className="flex-1">{t("list.labels")}</span>
        <span className="text-xs text-muted-foreground">
          {value.length === 0 ? t("list.any") : t("list.selectedCount", { count: value.length })}
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
  onProject,
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
  projects: ReadonlyArray<ProjectFaviconProject & { readonly id: ProjectId }>;
  projectId: ProjectId | undefined;
  projectEnvironmentId: EnvironmentId | undefined;
  unavailable: ReadonlyMap<string, string>;
  onProject: (projectId: ProjectId | undefined, environmentId: EnvironmentId | undefined) => void;
}) {
  const { t } = useTranslation("pullRequest");
  const selectedLabels = (filters.labels ?? []).flatMap((group) => group);
  const filterCount = [
    state !== "open",
    involvement !== "all",
    host,
    server,
    projectId,
    filters.draft,
    filters.review,
    filters.checks,
    filters.author,
    ...selectedLabels,
  ].filter(Boolean).length;
  const updateFilters = (next: Partial<PullRequestListFilters>) =>
    onFilters(
      Object.fromEntries(
        Object.entries({ ...filters, ...next }).filter(([, value]) => value !== undefined),
      ) as PullRequestListFilters,
    );
  const updateFilter = (key: keyof PullRequestListFilters, value: string) =>
    updateFilters({
      [key]: value === UNFILTERED_VALUE ? undefined : value,
    } as Partial<PullRequestListFilters>);
  const projectValue =
    projectId === undefined || projectEnvironmentId === undefined
      ? ALL_PROJECTS_VALUE
      : pullRequestProjectKey({ id: projectId, environmentId: projectEnvironmentId });
  const projectOptions: ReadonlyArray<PullRequestFilterOption<string>> = [
    { value: ALL_PROJECTS_VALUE, label: t("list.allProjects"), Icon: LayersIcon },
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
        <span>{t("list.filters")}</span>
        {filterCount > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {filterCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label={t("list.group.state")}
          value={state}
          options={stateOptions}
          onChange={onState}
        />
        <PullRequestFilterRadioSubmenu
          label={t("list.group.involvement")}
          value={involvement}
          options={involvementOptions}
          onChange={onInvolvement}
        />
        <MenuSeparator />
        <PullRequestAuthorFilter
          value={filters.author}
          options={authorOptions}
          scope={optionScope}
          onChange={(author) => updateFilters({ author })}
        />
        <PullRequestLabelFilter
          value={selectedLabels}
          options={labelOptions}
          scope={optionScope}
          onChange={(labels) =>
            updateFilters({
              labels: labels.length === 0 ? undefined : labels.slice(0, 10).map((label) => [label]),
            })
          }
        />
        <PullRequestFilterRadioSubmenu
          label={t("list.group.draft")}
          value={filters.draft ?? UNFILTERED_VALUE}
          options={DRAFT_OPTIONS}
          onChange={(draft) => updateFilter("draft", draft)}
        />
        <PullRequestFilterRadioSubmenu
          label={t("list.group.review")}
          value={filters.review ?? UNFILTERED_VALUE}
          options={REVIEW_OPTIONS}
          onChange={(review) => updateFilter("review", review)}
        />
        <PullRequestFilterRadioSubmenu
          label={t("list.group.checks")}
          value={filters.checks ?? UNFILTERED_VALUE}
          options={CHECKS_OPTIONS}
          onChange={(checks) => updateFilter("checks", checks)}
        />
        {hostOptions.length > 2 ? (
          <>
            <MenuSeparator />
            <PullRequestFilterRadioSubmenu
              label={t("list.group.host")}
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
              label={t("list.group.server")}
              value={server ?? ALL_SERVERS_VALUE}
              options={serverOptions}
              onChange={(next) =>
                onServer(next === ALL_SERVERS_VALUE ? undefined : (next as EnvironmentId))
              }
            />
          </>
        ) : null}
        <MenuSeparator />
        <PullRequestFilterRadioSubmenu
          label={t("list.group.project")}
          value={projectValue}
          options={projectOptions}
          onChange={(next) => {
            const project = projects.find((candidate) => pullRequestProjectKey(candidate) === next);
            if (project) onProject(project.id, project.environmentId);
            else if (projectId !== undefined) onProject(undefined, undefined);
          }}
        />
      </MenuPopup>
    </Menu>
  );
}
