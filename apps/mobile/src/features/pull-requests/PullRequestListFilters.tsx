import { useAtomValue } from "@effect/atom-react";
import { pullRequestRepositoryKey } from "@t3tools/client-runtime/pull-request-project-filter";
import { sortProjectsByGroupOrder } from "@t3tools/client-runtime/state/project-grouping";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Platform, ScrollView } from "react-native";
import type { MenuProps } from "../../components/ui/Menu.types";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "../home/homeThreadList";
import { DEFAULT_PR_LIST_CONTROLS, type PullRequestListControls } from "./pullRequestList";

const STATES = { open: "Open", closed: "Closed", merged: "Merged", all: "All states" } as const;
const INVOLVEMENT = { all: "All PRs", reviewing: "Your review", authored: "By you" } as const;
const DRAFTS = { all: "All drafts", only: "Drafts only", hide: "Hide drafts" } as const;
const REVIEWS = {
  all: "All reviews",
  approved: "Approved",
  "changes-requested": "Changes requested",
  "review-required": "Review required",
  none: "No reviews",
} as const;
const CHECKS = { all: "All checks", passing: "Passing", failing: "Failing" } as const;
const SORTS = {
  updated: "Recently updated",
  created: "Newest created",
  oldest: "Oldest updated",
} as const;
// A 12dp inset keeps 16dp chips concentric with Android's 28dp ScreenContent corner.
const ROW_STYLE =
  Platform.OS === "android"
    ? { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8, gap: 8 }
    : { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 };
const id = (field: string, value: string) => JSON.stringify([field, value]);
const EXCLUDABLE_FIELDS = ["author", "labels", "review", "checks", "project"] as const;
type ExcludableField = (typeof EXCLUDABLE_FIELDS)[number];
const isExcludableField = (value: string): value is ExcludableField =>
  (EXCLUDABLE_FIELDS as readonly string[]).includes(value);
function excludedSummary(names: readonly string[], noun: string) {
  return names.length === 1 ? `Not ${names[0]}` : `${names.length} ${noun} excluded`;
}
function choices(field: string, options: Readonly<Record<string, string>>, selected: string) {
  return Object.entries(options).map(([value, title]) => ({
    id: id(field, value),
    title,
    state: value === selected ? ("on" as const) : ("off" as const),
  }));
}

type ProjectOrder = readonly { readonly memberProjectRefs: readonly ScopedProjectRef[] }[];
const sameProjectOrder = (previous: ProjectOrder, next: ProjectOrder) =>
  previous.length === next.length &&
  previous.every((group, index) => {
    const members = next[index]!.memberProjectRefs;
    return (
      group.memberProjectRefs.length === members.length &&
      group.memberProjectRefs.every(
        (ref, member) =>
          ref.environmentId === members[member]!.environmentId &&
          ref.projectId === members[member]!.projectId,
      )
    );
  });

// Thread shells change on every agent tick, but the sidebar order they decide rarely does. The
// equality check keeps the list screen, which builds these filters, from re-rendering on each tick.
const sidebarProjectOrderFamily = Atom.family((mode: SidebarProjectGroupingMode) =>
  Atom.make((get) =>
    sortHomeProjectScopes({
      scopes: buildHomeProjectScopes({
        projects: get(environmentProjects.projectsAtom),
        environmentId: null,
        projectGroupingMode: mode,
      }),
      threads: get(environmentThreadShells.threadShellsAtom),
      pendingTasks: [],
      projectSortOrder: "updated_at",
    }).map((scope) => ({ memberProjectRefs: scope.projectRefs })),
  ).pipe(Atom.withEquality(sameProjectOrder)),
);

function useProjectsInSidebarOrder<Project extends { id: string; environmentId: string }>(
  projects: readonly Project[],
) {
  const { sidebarProjectGroupingMode } = useMobileProjectGroupingSettings();
  const scopes = useAtomValue(sidebarProjectOrderFamily(sidebarProjectGroupingMode));
  return sortProjectsByGroupOrder(projects, scopes);
}

export interface PullRequestFilterMenu {
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
  /** Whether any filter, the environment, or a non-default sort is active. */
  readonly customized: boolean;
}

/**
 * Builds the filter pills and, on Android, the header's full filter menu. The list screen owns
 * the call so both the pills and the header it frames read the same menu.
 */
export function usePullRequestListFilters(props: {
  readonly environments: readonly { id: string; label: string }[];
  readonly environmentId: string | null;
  readonly onEnvironmentChange: (id: string | null) => void;
  readonly value: PullRequestListControls;
  readonly onChange: (value: PullRequestListControls) => void;
  readonly authors: readonly string[];
  readonly labels: readonly string[];
  /** Dot colors by lowercased label name, for the labels that have one. */
  readonly labelColors: Readonly<Record<string, string>>;
  readonly projects: readonly {
    id: string;
    title: string;
    environmentId: string;
    repositoryIdentity?: { readonly canonicalKey?: string | undefined } | null | undefined;
  }[];
  /** Opens a picker that searches the host, for a label or author no loaded row carries. */
  readonly onSearch: (kind: "labels" | "authors", excluding: boolean) => void;
}) {
  const { value } = props;
  const projects = useProjectsInSidebarOrder(props.projects);
  const [preferExcluding, setPreferExcluding] = useState<ReadonlySet<ExcludableField>>(
    () => new Set(),
  );
  const selectedLabels = value.filters.labels?.flat() ?? [];
  const excludedLabels = value.filters.excludedLabels ?? [];
  const author = value.filters.author;
  const excludedAuthors = value.filters.excludedAuthors ?? [];
  const repositories = new Map<string, string>();
  for (const project of projects) {
    const key = pullRequestRepositoryKey(project);
    if (key && !repositories.has(key)) repositories.set(key, project.title);
  }
  const excludedRepositories = value.projectId
    ? []
    : (value.excludedRepositories ?? []).filter((key) => repositories.has(key));
  const picks = {
    author: { included: author !== undefined, excluded: excludedAuthors.length > 0 },
    labels: { included: selectedLabels.length > 0, excluded: excludedLabels.length > 0 },
    review: {
      included: value.filters.review !== undefined,
      excluded: value.filters.excludedReview !== undefined,
    },
    checks: {
      included: value.filters.checks !== undefined,
      excluded: value.filters.excludedChecks !== undefined,
    },
    project: { included: Boolean(value.projectId), excluded: excludedRepositories.length > 0 },
  } satisfies Record<ExcludableField, { included: boolean; excluded: boolean }>;
  // A pick on either side decides the mode; the toggle only matters while nothing is picked.
  const excluding = (field: ExcludableField) =>
    picks[field].excluded || (!picks[field].included && preferExcluding.has(field));
  const withFilters = (filters: Partial<PullRequestListControls["filters"]>) =>
    props.onChange({ ...value, filters: { ...value.filters, ...filters } });
  const toggled = (list: readonly string[], item: string, limit: number) =>
    list.includes(item) ? list.filter((held) => held !== item) : [...list, item].slice(0, limit);
  const listOrUndefined = (list: readonly string[]) => (list.length ? list : undefined);
  const toggleExcluding = (field: ExcludableField) => {
    const next = !excluding(field);
    setPreferExcluding((previous) => {
      const updated = new Set(previous);
      if (next) updated.add(field);
      else updated.delete(field);
      return updated;
    });
    switch (field) {
      case "author":
        if (next && author !== undefined)
          withFilters({ author: undefined, excludedAuthors: [author] });
        if (!next && excludedAuthors.length > 0)
          withFilters({ author: excludedAuthors[0], excludedAuthors: undefined });
        break;
      case "labels":
        if (next && selectedLabels.length > 0)
          withFilters({ labels: undefined, excludedLabels: selectedLabels });
        if (!next && excludedLabels.length > 0)
          withFilters({
            labels: excludedLabels.map((label) => [label]),
            excludedLabels: undefined,
          });
        break;
      case "review":
        if (picks.review.included || picks.review.excluded)
          withFilters({
            review: next ? undefined : value.filters.excludedReview,
            excludedReview: next ? value.filters.review : undefined,
          });
        break;
      case "checks":
        if (picks.checks.included || picks.checks.excluded)
          withFilters({
            checks: next ? undefined : value.filters.excludedChecks,
            excludedChecks: next ? value.filters.checks : undefined,
          });
        break;
      case "project": {
        const chosen = projects.find(
          (project) =>
            project.id === value.projectId && project.environmentId === value.projectEnvironmentId,
        );
        const chosenKey = chosen === undefined ? undefined : pullRequestRepositoryKey(chosen);
        if (next && chosenKey !== undefined)
          props.onChange({
            ...value,
            projectId: undefined,
            projectEnvironmentId: undefined,
            excludedRepositories: [chosenKey],
          });
        const first = projects.find(
          (project) => pullRequestRepositoryKey(project) === excludedRepositories[0],
        );
        if (!next && first !== undefined)
          props.onChange({
            ...value,
            projectId: first.id,
            projectEnvironmentId: first.environmentId,
            excludedRepositories: undefined,
          });
        break;
      }
    }
  };
  const select = (event: string) => {
    let selection: unknown;
    try {
      selection = JSON.parse(event);
    } catch {
      return;
    }
    if (
      !Array.isArray(selection) ||
      selection.length !== 2 ||
      typeof selection[0] !== "string" ||
      typeof selection[1] !== "string"
    )
      return;
    const [field, next] = selection;
    switch (field) {
      case "environment":
        if (next === "") props.onEnvironmentChange(null);
        else if (props.environments.some((environment) => environment.id === next))
          props.onEnvironmentChange(next);
        break;
      case "reset":
        setPreferExcluding(new Set());
        props.onChange(DEFAULT_PR_LIST_CONTROLS);
        // The Android header menu also holds the environment, so its reset clears that too.
        if (next === "environment") props.onEnvironmentChange(null);
        break;
      case "exclude":
        if (isExcludableField(next)) toggleExcluding(next);
        break;
      case "state":
        props.onChange({ ...value, state: next as PullRequestListControls["state"] });
        break;
      case "involvement":
        props.onChange({ ...value, involvement: next as PullRequestListControls["involvement"] });
        break;
      case "sort":
        props.onChange({ ...value, sort: next as PullRequestListControls["sort"] });
        break;
      case "project": {
        if (excluding("project") && next !== "") {
          props.onChange({
            ...value,
            excludedRepositories: listOrUndefined(toggled(excludedRepositories, next, 100)),
          });
          break;
        }
        const project = projects.find(
          (project) => JSON.stringify([project.environmentId, project.id]) === next,
        );
        props.onChange({
          ...value,
          projectId: project?.id,
          projectEnvironmentId: project?.environmentId,
          excludedRepositories: undefined,
        });
        break;
      }
      case "label":
        if (excluding("labels"))
          withFilters({ excludedLabels: listOrUndefined(toggled(excludedLabels, next, 10)) });
        else
          withFilters({
            labels: listOrUndefined(toggled(selectedLabels, next, 10))?.map((label) => [label]),
          });
        break;
      case "labels":
        withFilters({ labels: undefined, excludedLabels: undefined });
        break;
      case "author":
        if (next === "") withFilters({ author: undefined, excludedAuthors: undefined });
        else if (excluding("author"))
          withFilters({ excludedAuthors: listOrUndefined(toggled(excludedAuthors, next, 10)) });
        else withFilters({ author: next });
        break;
      case "search":
        if (next === "labels" || next === "authors")
          props.onSearch(next, excluding(next === "labels" ? "labels" : "author"));
        break;
      case "draft":
        withFilters({ draft: next === "all" ? undefined : (next as "only" | "hide") });
        break;
      case "review": {
        const review =
          next === "all"
            ? undefined
            : (next as NonNullable<PullRequestListControls["filters"]["review"]>);
        withFilters(
          excluding("review")
            ? { review: undefined, excludedReview: review }
            : { review, excludedReview: undefined },
        );
        break;
      }
      case "checks": {
        const checks = next === "all" ? undefined : (next as "passing" | "failing");
        withFilters(
          excluding("checks")
            ? { checks: undefined, excludedChecks: checks }
            : { checks, excludedChecks: undefined },
        );
        break;
      }
    }
  };
  const excludeToggle = (field: ExcludableField): MenuProps["actions"][number] => ({
    id: id("exclude", field),
    title: "Exclude matches",
    state: excluding(field) ? "on" : "off",
  });
  const count =
    Number(value.state !== "open") +
    Number(value.involvement !== "all") +
    Number(Boolean(author)) +
    excludedAuthors.length +
    selectedLabels.length +
    excludedLabels.length +
    Number(Boolean(value.filters.draft)) +
    Number(Boolean(value.filters.review)) +
    Number(Boolean(value.filters.excludedReview)) +
    Number(Boolean(value.filters.checks)) +
    Number(Boolean(value.filters.excludedChecks)) +
    Number(Boolean(value.projectId)) +
    excludedRepositories.length;
  const selectedProject = projects.find(
    (project) =>
      project.id === value.projectId && project.environmentId === value.projectEnvironmentId,
  );
  const more: MenuProps["actions"] = [
    {
      id: "drafts",
      title: value.filters.draft ? DRAFTS[value.filters.draft] : "Drafts",
      subactions: choices("draft", DRAFTS, value.filters.draft ?? "all"),
    },
    {
      id: "reviews",
      title: value.filters.excludedReview
        ? `Not ${REVIEWS[value.filters.excludedReview].toLowerCase()}`
        : value.filters.review
          ? REVIEWS[value.filters.review]
          : "Reviews",
      subactions: [
        excludeToggle("review"),
        ...choices(
          "review",
          REVIEWS,
          (excluding("review") ? value.filters.excludedReview : value.filters.review) ?? "all",
        ),
      ],
    },
    {
      id: "checks",
      title: value.filters.excludedChecks
        ? `Not ${CHECKS[value.filters.excludedChecks].toLowerCase()} checks`
        : value.filters.checks
          ? `${CHECKS[value.filters.checks]} checks`
          : "Checks",
      subactions: [
        excludeToggle("checks"),
        ...choices(
          "checks",
          CHECKS,
          (excluding("checks") ? value.filters.excludedChecks : value.filters.checks) ?? "all",
        ),
      ],
    },
    {
      id: "projects",
      title:
        excludedRepositories.length > 0
          ? excludedSummary(
              excludedRepositories.map((key) => repositories.get(key) ?? key),
              "projects",
            )
          : (selectedProject?.title ?? "Project"),
      subactions: [
        excludeToggle("project"),
        ...(excluding("project")
          ? [...repositories].map(([key, title]) => ({
              id: id("project", key),
              title,
              state: excludedRepositories.includes(key) ? ("on" as const) : ("off" as const),
            }))
          : choices(
              "project",
              Object.fromEntries([
                ["", "All projects"],
                ...projects.map((project) => [
                  JSON.stringify([project.environmentId, project.id]),
                  project.title,
                ]),
              ]),
              value.projectId ? JSON.stringify([value.projectEnvironmentId, value.projectId]) : "",
            )),
      ],
    },
    { id: "sort", title: SORTS[value.sort], subactions: choices("sort", SORTS, value.sort) },
  ];
  const reset = (withEnvironment: boolean): MenuProps["actions"][number] => ({
    id: id("reset", withEnvironment ? "environment" : ""),
    title: "Reset filters",
    attributes: {
      disabled:
        count === 0 &&
        value.sort === "updated" &&
        (!withEnvironment || props.environmentId === null),
    },
  });
  const labelsExcluding = excluding("labels");
  const pickedLabels = labelsExcluding ? excludedLabels : selectedLabels;
  const labels = [...new Set([...pickedLabels, ...props.labels])].slice(0, 60);
  const authorsExcluding = excluding("author");
  const pickedAuthors = authorsExcluding ? excludedAuthors : author ? [author] : [];
  const authors = [
    ...new Set([...pickedAuthors.filter((login) => login !== "me"), ...props.authors]),
  ].slice(0, 60);
  const environmentActions = choices(
    "environment",
    Object.fromEntries([
      ["", "All environments"],
      ...props.environments.map((environment) => [environment.id, environment.label]),
    ]),
    props.environmentId ?? "",
  );
  const stateActions = choices("state", STATES, value.state);
  const involvementActions = choices("involvement", INVOLVEMENT, value.involvement);
  const labelActions: MenuProps["actions"] = [
    excludeToggle("labels"),
    { id: id("search", "labels"), title: "Search labels…", image: "magnifyingglass" },
    { id: id("labels", ""), title: "All labels", state: pickedLabels.length ? "off" : "on" },
    ...labels.map((label) => {
      const color = props.labelColors[label.toLowerCase()];
      return {
        id: id("label", label),
        title: label,
        state: pickedLabels.includes(label) ? ("on" as const) : ("off" as const),
        ...(color ? { image: "circle.fill", imageColor: color } : {}),
      };
    }),
  ];
  const authorActions: MenuProps["actions"] = [
    excludeToggle("author"),
    { id: id("search", "authors"), title: "Search authors…", image: "magnifyingglass" },
    { id: id("author", ""), title: "All authors", state: pickedAuthors.length ? "off" : "on" },
    ...[["me", "Me"] as const, ...authors.map((login) => [login, login] as const)].map(
      ([login, title]) => ({
        id: id("author", login),
        title,
        state: pickedAuthors.includes(login) ? ("on" as const) : ("off" as const),
      }),
    ),
  ];
  const customized = count > 0 || value.sort !== "updated" || props.environmentId !== null;
  // The Android header's filter button opens every filter.
  const headerMenu: PullRequestFilterMenu | null =
    Platform.OS === "android"
      ? {
          actions: [
            { id: "environment", title: "Environment", subactions: environmentActions },
            { id: "state", title: "State", subactions: stateActions },
            { id: "involvement", title: "Involvement", subactions: involvementActions },
            { id: "labels", title: "Labels", subactions: labelActions },
            { id: "author", title: "Author", subactions: authorActions },
            ...more,
            reset(true),
          ],
          onSelect: select,
          customized,
        }
      : null;
  return {
    headerMenu,
    select,
    count,
    more,
    reset,
    environmentLabel:
      props.environments.length > 1
        ? (props.environments.find((environment) => environment.id === props.environmentId)
            ?.label ?? "All environments")
        : null,
    environmentActions,
    state: value.state,
    stateActions,
    involvement: value.involvement,
    involvementActions,
    labelLabel:
      excludedLabels.length > 0
        ? excludedSummary(excludedLabels, "labels")
        : selectedLabels.length
          ? `Labels ${selectedLabels.length}`
          : "Labels",
    labelActive: selectedLabels.length + excludedLabels.length > 0,
    labelActions,
    authorLabel:
      excludedAuthors.length > 0
        ? excludedSummary(
            excludedAuthors.map((login) => (login === "me" ? "you" : login)),
            "authors",
          )
        : author === "me"
          ? "By you"
          : (author ?? "Author"),
    authorActive: author !== undefined || excludedAuthors.length > 0,
    authorActions,
  };
}

export function PullRequestListFilters(props: {
  /** Android sidebar rows sit further in than full-width rows; the pills follow them. */
  readonly sidebar?: boolean;
  readonly filters: ReturnType<typeof usePullRequestListFilters>;
}) {
  const { count, more, reset, select } = props.filters;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ overflow: "visible" }}
      // In the Android sidebar the first pill lines up with the rows' content instead
      // (8dp row margin + 12dp padding).
      contentContainerStyle={
        props.sidebar && Platform.OS === "android"
          ? { ...ROW_STYLE, paddingHorizontal: 20 }
          : ROW_STYLE
      }
    >
      {Platform.OS === "android" ? null : (
        <ListFilterMenu
          label={count ? String(count) : "Filters"}
          icon
          active={count > 0}
          accessibilityLabel={count ? `Filters, ${count} active` : "More filters"}
          actions={[...more, reset(false)]}
          onSelect={select}
        />
      )}
      {props.filters.environmentLabel !== null ? (
        <ListFilterMenu
          label={props.filters.environmentLabel}
          accessibilityLabel="Choose pull request environment"
          actions={props.filters.environmentActions}
          onSelect={select}
        />
      ) : null}
      <ListFilterMenu
        label={STATES[props.filters.state]}
        active={props.filters.state !== "open"}
        accessibilityLabel="Filter by state"
        actions={props.filters.stateActions}
        onSelect={select}
      />
      <ListFilterMenu
        label={INVOLVEMENT[props.filters.involvement]}
        active={props.filters.involvement !== "all"}
        accessibilityLabel="Filter by involvement"
        actions={props.filters.involvementActions}
        onSelect={select}
      />
      <ListFilterMenu
        label={props.filters.labelLabel}
        active={props.filters.labelActive}
        accessibilityLabel="Filter by label"
        actions={props.filters.labelActions}
        onSelect={select}
      />
      <ListFilterMenu
        label={props.filters.authorLabel}
        active={props.filters.authorActive}
        accessibilityLabel="Filter by author"
        actions={props.filters.authorActions}
        onSelect={select}
      />
    </ScrollView>
  );
}
