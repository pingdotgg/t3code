import { useAtomValue } from "@effect/atom-react";
import { sortProjectsByGroupOrder } from "@t3tools/client-runtime/state/project-grouping";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { Platform, ScrollView } from "react-native";
import type { MenuProps } from "../../components/ui/Menu.types";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
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
  return useMemo(() => sortProjectsByGroupOrder(projects, scopes), [projects, scopes]);
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
  readonly projects: readonly { id: string; title: string; environmentId: string }[];
  /** Opens a picker that searches the host, for a label or author no loaded row carries. */
  readonly onSearch: (kind: "labels" | "authors") => void;
}) {
  const { value } = props;
  const projects = useProjectsInSidebarOrder(props.projects);
  const selectedLabels = value.filters.labels?.flat() ?? [];
  const selectedLabelSet = new Set(selectedLabels);
  const author = value.filters.author;
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
        props.onChange(DEFAULT_PR_LIST_CONTROLS);
        // The Android header menu also holds the environment, so its reset clears that too.
        if (next === "environment") props.onEnvironmentChange(null);
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
        const project = projects.find(
          (project) => JSON.stringify([project.environmentId, project.id]) === next,
        );
        props.onChange({
          ...value,
          projectId: project?.id,
          projectEnvironmentId: project?.environmentId,
        });
        break;
      }
      case "label": {
        const labels = selectedLabels.includes(next)
          ? selectedLabels.filter((label) => label !== next)
          : [...selectedLabels, next].slice(0, 10);
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            labels: labels.length ? labels.map((label) => [label]) : undefined,
          },
        });
        break;
      }
      case "labels":
        props.onChange({ ...value, filters: { ...value.filters, labels: undefined } });
        break;
      case "author":
        props.onChange({ ...value, filters: { ...value.filters, author: next || undefined } });
        break;
      case "search":
        if (next === "labels" || next === "authors") props.onSearch(next);
        break;
      case "draft":
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            draft: next === "all" ? undefined : (next as "only" | "hide"),
          },
        });
        break;
      case "review":
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            review:
              next === "all"
                ? undefined
                : (next as NonNullable<PullRequestListControls["filters"]["review"]>),
          },
        });
        break;
      case "checks":
        props.onChange({
          ...value,
          filters: {
            ...value.filters,
            checks: next === "all" ? undefined : (next as "passing" | "failing"),
          },
        });
        break;
    }
  };
  const count =
    Number(value.state !== "open") +
    Number(value.involvement !== "all") +
    Number(Boolean(author)) +
    selectedLabels.length +
    Number(Boolean(value.filters.draft)) +
    Number(Boolean(value.filters.review)) +
    Number(Boolean(value.filters.checks)) +
    Number(Boolean(value.projectId));
  const more: MenuProps["actions"] = [
    {
      id: "drafts",
      title: value.filters.draft ? DRAFTS[value.filters.draft] : "Drafts",
      subactions: choices("draft", DRAFTS, value.filters.draft ?? "all"),
    },
    {
      id: "reviews",
      title: value.filters.review ? REVIEWS[value.filters.review] : "Reviews",
      subactions: choices("review", REVIEWS, value.filters.review ?? "all"),
    },
    {
      id: "checks",
      title: value.filters.checks ? `${CHECKS[value.filters.checks]} checks` : "Checks",
      subactions: choices("checks", CHECKS, value.filters.checks ?? "all"),
    },
    {
      id: "projects",
      title:
        projects.find(
          (project) =>
            project.id === value.projectId && project.environmentId === value.projectEnvironmentId,
        )?.title ?? "Project",
      subactions: choices(
        "project",
        Object.fromEntries([
          ["", "All projects"],
          ...projects.map((project) => [
            JSON.stringify([project.environmentId, project.id]),
            project.title,
          ]),
        ]),
        value.projectId ? JSON.stringify([value.projectEnvironmentId, value.projectId]) : "",
      ),
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
  const labels = [...new Set([...selectedLabels, ...props.labels])].slice(0, 60);
  const authors = [
    ...new Set([...(author && author !== "me" ? [author] : []), ...props.authors]),
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
    { id: id("search", "labels"), title: "Search labels…", image: "magnifyingglass" },
    { id: id("labels", ""), title: "All labels", state: selectedLabels.length ? "off" : "on" },
    ...labels.map((label) => {
      const color = props.labelColors[label.toLowerCase()];
      return {
        id: id("label", label),
        title: label,
        state: selectedLabelSet.has(label) ? ("on" as const) : ("off" as const),
        ...(color ? { image: "circle.fill", imageColor: color } : {}),
      };
    }),
  ];
  const authorActions: MenuProps["actions"] = [
    { id: id("search", "authors"), title: "Search authors…", image: "magnifyingglass" },
    ...choices(
      "author",
      Object.fromEntries([
        ["", "All authors"],
        ["me", "Me"],
        ...authors.map((login) => [login, login]),
      ]),
      author ?? "",
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
    selectedLabelCount: selectedLabels.length,
    labelActions,
    author,
    authorActions,
  };
}

export function PullRequestListFilters(props: {
  /** Android sidebar rows sit further in than full-width rows; the pills follow them. */
  readonly sidebar?: boolean;
  readonly filters: ReturnType<typeof usePullRequestListFilters>;
}) {
  const { count, more, reset, select, author, selectedLabelCount } = props.filters;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
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
        label={selectedLabelCount ? `Labels ${selectedLabelCount}` : "Labels"}
        active={selectedLabelCount > 0}
        accessibilityLabel="Filter by label"
        actions={props.filters.labelActions}
        onSelect={select}
      />
      <ListFilterMenu
        label={author === "me" ? "By you" : (author ?? "Author")}
        active={Boolean(author)}
        accessibilityLabel="Filter by author"
        actions={props.filters.authorActions}
        onSelect={select}
      />
    </ScrollView>
  );
}
