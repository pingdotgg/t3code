import type { StaticScreenProps } from "@react-navigation/native";
import { listLinearMilestones } from "@t3tools/client-runtime/linear/issue-list";
import {
  clearLinearFilters,
  hasActiveLinearFilters,
  linearIssueFilter,
  NO_MILESTONE_ID,
  DEFAULT_LINEAR_GROUP,
  T3_ACTIVITY_VIEW,
} from "@t3tools/client-runtime/linear/search";
import { EnvironmentId, type LinearMilestone } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useDebouncedValue } from "../../state/queries";
import { LinearBanner, LinearListError, LinearListSkeleton } from "./LinearPanels";
import { LinearFilterPills, LinearList, LinearScreen } from "./LinearScreen";
import {
  LinearGroupHeader,
  LinearMilestoneRow,
  LinearNoMilestoneRow,
  LinearProgressSummary,
  LinearProjectRow,
} from "./LinearLevels";
import { LinearIssueRow, type LinearIssueRowContext } from "./LinearIssueRow";
import { buildLinearFilterPills, linearFilterPatch } from "./linearFilterMenu";
import { linearIssueListItems, type LinearIssueListItem } from "./linearIssueItems";
import {
  linearFiltersOf,
  linearScopeFromParams,
  linearSearchFor,
  type LinearRouteParams,
} from "./linearRoutes";
import {
  useAdoptLinearEnvironment,
  useLinearActivity,
  useLinearAutoRefresh,
  useLinearDegradation,
  useLinearIssues,
  useLinearMilestones,
  useLinearProjects,
  useLinearRefresh,
  useLinearStatus,
  useLinearTeamMetadata,
  useLinearViews,
} from "./useLinearData";
import { useLinearFilters, useLinearNavigation } from "./useLinearNavigation";

const EMPTY_LIST: ReadonlyArray<never> = [];
const EMPTY_VIEWS: ReadonlyArray<never> = [];
const SEARCH_DEBOUNCE_MS = 250;

export function LinearTeamScreen({ route }: StaticScreenProps<LinearRouteParams["LinearTeam"]>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const scope = linearScopeFromParams(route.params);
  const status = useLinearStatus(environmentId);
  const projects = useLinearProjects(environmentId, scope.team);
  const { refresh, refreshing } = useLinearRefresh(environmentId);
  const navigation = useLinearNavigation(environmentId, scope);
  useAdoptLinearEnvironment(environmentId);
  useLinearAutoRefresh(true);
  const degradation = useLinearDegradation(environmentId, [projects.failure], false);
  const team = status.data?.teams.find((entry) => entry.id === scope.team);
  return (
    <LinearScreen title={team?.name ?? "Team"} subtitle={team?.key}>
      <LinearList
        data={projects.data ?? EMPTY_LIST}
        keyExtractor={(project) => project.id}
        estimatedItemSize={64}
        refreshing={refreshing}
        onRefresh={refresh}
        ListHeaderComponent={
          degradation ? (
            <LinearBanner degradation={degradation} onRetry={refresh} retrying={refreshing} />
          ) : null
        }
        renderItem={({ item }) => (
          <LinearProjectRow
            project={item}
            onOpen={(projectId) => navigation.openScope({ team: scope.team, project: projectId })}
          />
        )}
        ListEmptyComponent={
          projects.data === null ? (
            projects.error === null ? (
              <LinearListSkeleton label="Loading projects" />
            ) : (
              <LinearListError message="Couldn't load projects." onRetry={projects.refresh} />
            )
          ) : (
            <Text className="px-8 py-12 text-center text-sm text-foreground-muted">
              No projects in this team.
            </Text>
          )
        }
      />
    </LinearScreen>
  );
}

type MilestoneListItem =
  | { readonly type: "milestone"; readonly milestone: LinearMilestone }
  | { readonly type: "none" }
  | { readonly type: "toggle"; readonly count: number };

export function LinearProjectScreen({
  route,
}: StaticScreenProps<LinearRouteParams["LinearProject"]>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const scope = linearScopeFromParams(route.params);
  const status = useLinearStatus(environmentId);
  const projects = useLinearProjects(environmentId, scope.team);
  const milestones = useLinearMilestones(environmentId, scope.project);
  const { refresh, refreshing } = useLinearRefresh(environmentId);
  const navigation = useLinearNavigation(environmentId, scope);
  const { filters, patch } = useLinearFilters();
  useAdoptLinearEnvironment(environmentId);
  useLinearAutoRefresh(true);
  const degradation = useLinearDegradation(
    environmentId,
    [milestones.failure, projects.failure],
    false,
  );
  const team = status.data?.teams.find((entry) => entry.id === scope.team);
  const project = projects.data?.find((entry) => entry.id === scope.project);
  const showCompleted = filters.showCompleted === true;
  const { visible, completedCount } = listLinearMilestones(
    milestones.data ?? EMPTY_LIST,
    showCompleted,
  );
  const items: ReadonlyArray<MilestoneListItem> =
    milestones.data === null
      ? []
      : [
          ...visible.map((milestone): MilestoneListItem => ({ type: "milestone", milestone })),
          { type: "none" },
          ...(completedCount > 0 ? [{ type: "toggle", count: completedCount } as const] : []),
        ];
  return (
    <LinearScreen title={project?.name ?? "Project"} subtitle={team?.name}>
      <LinearList
        data={items}
        keyExtractor={(item) => (item.type === "milestone" ? item.milestone.id : item.type)}
        getItemType={(item) => item.type}
        estimatedItemSize={64}
        refreshing={refreshing}
        onRefresh={refresh}
        ListHeaderComponent={
          degradation ? (
            <LinearBanner degradation={degradation} onRetry={refresh} retrying={refreshing} />
          ) : null
        }
        renderItem={({ item }) =>
          item.type === "milestone" ? (
            <LinearMilestoneRow
              milestone={item.milestone}
              onOpen={(milestoneId) => navigation.openScope({ ...scope, milestone: milestoneId })}
            />
          ) : item.type === "none" ? (
            <LinearNoMilestoneRow
              onOpen={() => navigation.openScope({ ...scope, milestone: NO_MILESTONE_ID })}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => patch({ showCompleted: showCompleted ? undefined : true })}
              className="px-4 py-3 active:opacity-60"
            >
              <Text className="text-sm text-foreground-muted">
                {showCompleted ? "Hide completed" : `Show completed (${item.count})`}
              </Text>
            </Pressable>
          )
        }
        ListEmptyComponent={
          milestones.error === null ? (
            <LinearListSkeleton label="Loading milestones" />
          ) : (
            <LinearListError message="Couldn't load milestones." onRetry={milestones.refresh} />
          )
        }
      />
    </LinearScreen>
  );
}

export function LinearMilestoneScreen({
  route,
}: StaticScreenProps<LinearRouteParams["LinearMilestone"]>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const scope = linearScopeFromParams(route.params);
  const { width } = useWindowDimensions();
  const status = useLinearStatus(environmentId);
  const metadata = useLinearTeamMetadata(environmentId, scope.team);
  const views = useLinearViews(environmentId);
  const milestones = useLinearMilestones(environmentId, scope.project);
  const activity = useLinearActivity(environmentId);
  const { refresh, refreshing } = useLinearRefresh(environmentId);
  const navigation = useLinearNavigation(environmentId, scope);
  const { filters, patch, reset } = useLinearFilters();
  const [text, setText] = useState("");
  const debouncedText = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useAdoptLinearEnvironment(environmentId);
  useLinearAutoRefresh(true);

  const search = linearSearchFor(scope, {
    ...filters,
    ...(debouncedText === "" ? {} : { q: debouncedText }),
  });
  const activityIssueIds = activity.issues.map((entry) => entry.issueId).slice(0, 250);
  // "Has T3 activity" with nothing linked yet is empty by definition; an empty id list is not
  // "no restriction" to the server, so it never gets asked.
  const noActivity = search.view === T3_ACTIVITY_VIEW && activityIssueIds.length === 0;
  const issues = useLinearIssues(
    environmentId,
    noActivity ? null : linearIssueFilter(search, { activityIssueIds }),
  );
  const degradation = useLinearDegradation(
    environmentId,
    [issues.failure, metadata.failure, views.failure],
    issues.data?.stale === true,
  );
  const result = noActivity ? { issues: EMPTY_LIST, truncated: false } : issues.data;
  const milestone = milestones.data?.find((entry) => entry.id === scope.milestone);
  const isNoMilestone = scope.milestone === NO_MILESTONE_ID;
  const statePositions = new Map(
    (metadata.data?.states ?? []).map((state) => [state.id, state.position]),
  );
  const items = linearIssueListItems(
    result?.issues ?? EMPTY_LIST,
    search.group ?? DEFAULT_LINEAR_GROUP,
    statePositions,
    collapsed,
  );
  const pills = buildLinearFilterPills({
    search,
    metadata: metadata.data,
    views: views.data ?? EMPTY_VIEWS,
    viewer: status.data?.viewer ?? null,
  });
  const selectFilter = (event: string) => {
    const change = linearFilterPatch(search, event);
    if (change !== null) patch(change);
  };
  const rowContext: LinearIssueRowContext = {
    environmentId,
    activityByIssueId: activity.byIssueId,
    onSelect: navigation.openIssue,
  };
  const completedHidden = search.showCompleted !== true && (search.states?.length ?? 0) === 0;
  const toggleGroup = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const renderItem = ({ item }: { readonly item: LinearIssueListItem }) =>
    item.type === "header" ? (
      <LinearGroupHeader
        label={item.label}
        count={item.count}
        stateType={item.stateType}
        stateColor={item.stateColor}
        collapsed={item.collapsed}
        onToggle={() => toggleGroup(item.key.replace(/^group:/u, ""))}
      />
    ) : (
      <LinearIssueRow issue={item.issue} context={rowContext} />
    );
  return (
    <LinearScreen
      title={isNoMilestone ? "No milestone" : (milestone?.name ?? "Milestone")}
      subtitle={status.data?.teams.find((entry) => entry.id === scope.team)?.name}
      search={{
        value: text,
        onChangeText: setText,
        placeholder: "Search issues",
        compactPlaceholder: "Search",
        mode: "inline",
        compactToolbar: width < 700,
      }}
    >
      <LinearList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        extraData={rowContext}
        estimatedItemSize={76}
        refreshing={refreshing}
        onRefresh={refresh}
        renderItem={renderItem}
        ListHeaderComponent={
          <View>
            {degradation ? (
              <LinearBanner degradation={degradation} onRetry={refresh} retrying={refreshing} />
            ) : null}
            {milestone ? (
              <View className="px-4 pb-2">
                <LinearProgressSummary
                  progress={milestone.progress}
                  issueCount={milestone.issueCount}
                  issueCountCapped={milestone.issueCountCapped}
                  targetDate={milestone.targetDate}
                />
              </View>
            ) : null}
            <LinearFilterPills pills={pills} onSelect={selectFilter} />
          </View>
        }
        ListFooterComponent={
          result?.truncated ? (
            <Text className="px-4 py-4 text-center text-xs text-foreground-muted">
              Showing first 250 issues. Narrow the filters to see the rest.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          result === null ? (
            issues.error === null ? (
              <LinearListSkeleton label="Loading issues" />
            ) : (
              <LinearListError message="Couldn't load issues." onRetry={issues.refresh} />
            )
          ) : (
            <View className="items-start gap-3 px-4 py-6">
              <Text className="text-sm text-foreground-muted">
                {completedHidden
                  ? "No open issues match. Completed issues are hidden."
                  : "No issues match."}
              </Text>
              {completedHidden ? (
                <Button label="Show completed" onPress={() => patch({ showCompleted: true })} />
              ) : null}
              {hasActiveLinearFilters(search) ? (
                <Button
                  label="Clear filters"
                  onPress={() => {
                    setText("");
                    reset(linearFiltersOf(clearLinearFilters(search)));
                  }}
                />
              ) : null}
            </View>
          )
        }
      />
    </LinearScreen>
  );
}
