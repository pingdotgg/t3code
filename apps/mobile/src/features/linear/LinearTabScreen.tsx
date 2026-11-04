import { useAtomSet } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { buildLinearJumpTargets, type LinearJumpTarget } from "@t3tools/client-runtime/linear/jump";
import {
  jumpBackInIssueIds,
  orderJumpBackInIssues,
  runningCountByTeam,
} from "@t3tools/client-runtime/linear/activity";
import type { LinearScope } from "@t3tools/client-runtime/linear/search";
import type { LinearIssue, LinearTeam } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { linearSelectedEnvironmentIdAtom } from "../../state/linear";
import { useDebouncedValue } from "../../state/queries";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import {
  LinearIssueRow,
  useLinearExpandedIssues,
  type LinearIssueRowContext,
} from "./LinearIssueRow";
import { LinearTeamCard } from "./LinearLevels";
import {
  LinearBanner,
  LinearListSkeleton,
  LinearNotConnected,
  LinearSectionTitle,
} from "./LinearPanels";
import { LinearList } from "./LinearScreen";
import { LinearGlyph } from "./linearIcons";
import { resolveLinearTabState } from "./linearEnvironment";
import {
  useLinearActivity,
  useLinearAutoRefresh,
  useLinearDegradation,
  useLinearEnvironmentId,
  useLinearIssues,
  useLinearProjects,
  useLinearRefresh,
  useLinearSearchIssues,
  useLinearStatus,
} from "./useLinearData";
import {
  clearLinearLocation,
  currentLinearLocation,
  hydrateLinearLocation,
  setLinearLocationOrganization,
} from "./linear-location-store";
import { isLinearStackRoute, linearRoutesToResume } from "./linearResume";
import { useLinearNavigation } from "./useLinearNavigation";

const EMPTY_LIST: ReadonlyArray<never> = [];
const JUMP_SEARCH_DEBOUNCE_MS = 200;
const NO_SCOPE: LinearScope = {};

type TabItem =
  | { readonly type: "title"; readonly key: string; readonly text: string }
  | { readonly type: "team"; readonly key: string; readonly team: LinearTeam }
  | { readonly type: "issue"; readonly key: string; readonly issue: LinearIssue }
  | { readonly type: "jump"; readonly key: string; readonly target: LinearJumpTarget };

const JUMP_ICON = {
  team: "person.2",
  project: "folder",
  milestone: "target",
  issue: "doc.text",
} as const;

function JumpResultRow(props: {
  readonly target: LinearJumpTarget;
  readonly onOpen: (target: LinearJumpTarget) => void;
}) {
  const { target } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${target.kind} ${target.kind === "issue" ? `${target.identifier} ` : ""}${target.label}`}
      onPress={() => props.onOpen(target)}
      className="min-h-12 flex-row items-center gap-3 px-4 active:bg-row-hover"
    >
      <SymbolView name={JUMP_ICON[target.kind]} size={16} tintColorClassName="accent-icon-muted" />
      <Text className="min-w-0 flex-1 py-3 text-base" numberOfLines={1}>
        {target.kind === "issue" ? (
          <Text className="font-mono text-xs text-foreground-muted">{target.identifier} </Text>
        ) : null}
        {target.label}
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

/**
 * When the Linear tab opens (not on later renders), pushes the screens the user last had open,
 * so leaving to a chat and coming back lands on the same scope or issue. The stack is the one a
 * manual drill-down would build, so native back still goes level by level.
 */
function useResumeLinearLocation(input: {
  readonly environmentId: string | null;
  readonly organizationId: string | null;
  readonly visible: boolean;
}) {
  const navigation = useNavigation();
  const resumed = useRef(false);
  const { environmentId, organizationId, visible } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reopens the remembered native stack once per visit to the Linear tab
  useEffect(() => {
    if (!visible) {
      resumed.current = false;
      return;
    }
    if (resumed.current || environmentId === null || organizationId === null) return;
    let cancelled = false;
    void hydrateLinearLocation().then(() => {
      if (cancelled) return;
      resumed.current = true;
      const stored = currentLinearLocation();
      const routes = linearRoutesToResume({ stored, environmentId, organizationId });
      if (stored !== null && stored.environmentId === environmentId && routes.length === 0) {
        clearLinearLocation();
        return;
      }
      setLinearLocationOrganization(environmentId, organizationId);
      const state = navigation.getState();
      const top = state?.routes[state.index]?.name;
      // A deep link already put a Linear screen on top; it wins and was recorded as the location.
      if (isLinearStackRoute(top)) return;
      for (const route of routes) {
        navigation.dispatch(StackActions.push(route.name, route.params));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, organizationId, visible, navigation]);
}

/**
 * The Linear tab: teams and "Jump back in" at the workspace level. Deeper levels are pushed
 * stack screens (see Stack.tsx), so native back is the breadcrumb.
 */
export function LinearTabScreen(props: {
  /** Places the list under a header (the Android toolbar). */
  readonly renderFrame?: (list: ReactNode) => ReactNode;
}) {
  const workspace = useWorkspaceTabs()!;
  const environments = useWorkspaceEnvironments();
  const setSelectedEnvironment = useAtomSet(linearSelectedEnvironmentIdAtom);
  const environmentId = useLinearEnvironmentId();
  const status = useLinearStatus(environmentId);
  const tab = workspace.state.tabs.linear;
  const visible = workspace.state.selectedTab === "linear" && !workspace.settingsOpen;
  const state = resolveLinearTabState({
    environmentId,
    connection: status.data?.state ?? null,
    failure: status.failure,
    hasError: status.error !== null,
  });
  const connected = state === "connected";
  useResumeLinearLocation({
    environmentId,
    organizationId: connected ? (status.data?.organization?.id ?? null) : null,
    visible,
  });
  const { refresh, refreshing } = useLinearRefresh(environmentId);
  const navigation = useLinearNavigation(environmentId, NO_SCOPE);
  const expansion = useLinearExpandedIssues(`tab:${environmentId ?? ""}`);
  const activity = useLinearActivity(environmentId, connected);
  const term = tab.searchMode === "resting" ? "" : tab.query.trim();
  const debouncedTerm = useDebouncedValue(term, JUMP_SEARCH_DEBOUNCE_MS);
  const jumpBackInIds = connected ? jumpBackInIssueIds(activity.issues) : EMPTY_LIST;
  const jumpBackIn = useLinearIssues(
    environmentId,
    jumpBackInIds.length === 0
      ? null
      : { assignee: "me", issueIds: [...jumpBackInIds], includeCompleted: true },
  );
  const jumpIssues = useLinearSearchIssues(environmentId, connected ? debouncedTerm : "");
  const allProjects = useLinearProjects(environmentId, undefined, connected && term !== "");
  useLinearAutoRefresh(visible, [status, activity, jumpBackIn]);
  const degradation = useLinearDegradation(
    environmentId,
    [activity.failure, jumpBackIn.failure],
    jumpBackIn.data?.stale === true,
  );

  const teams = status.data?.teams ?? EMPTY_LIST;
  const runningByTeam = runningCountByTeam(activity.issues);
  const rowContext: LinearIssueRowContext = {
    environmentId,
    activityByIssueId: activity.byIssueId,
    onSelect: navigation.openIssue,
    ...expansion,
  };
  // Until the debounced search lands, an empty list means "not asked yet", not "nothing found".
  const searching = term !== debouncedTerm || jumpIssues.isPending || allProjects.isPending;
  const jumpTargets = buildLinearJumpTargets(term, {
    teams,
    projects: allProjects.data ?? EMPTY_LIST,
    milestones: EMPTY_LIST,
    issues: jumpIssues.data ?? EMPTY_LIST,
  });
  const openJumpTarget = (target: LinearJumpTarget) =>
    target.kind === "issue" ? navigation.openIssue(target.id) : navigation.openScope(target.scope);

  const connectedEnvironments = environments.filter(
    (environment) => environment.isEnabled && environment.connectionState === "connected",
  );
  const jumpBackInIssues = orderJumpBackInIssues(
    jumpBackIn.data?.issues ?? EMPTY_LIST,
    activity.issues,
  );
  const items: ReadonlyArray<TabItem> = !connected
    ? EMPTY_LIST
    : term !== ""
      ? jumpTargets.map((target) => ({
          type: "jump",
          key: `${target.kind}:${target.id}`,
          target,
        }))
      : [
          { type: "title", key: "teams", text: "Teams" },
          ...teams.map((team) => ({ type: "team", key: team.id, team }) as const),
          ...(jumpBackInIssues.length > 0
            ? [
                { type: "title", key: "jump-back-in", text: "Jump back in" } as const,
                ...jumpBackInIssues.map(
                  (issue) => ({ type: "issue", key: issue.id, issue }) as const,
                ),
              ]
            : []),
        ];

  const environmentActions = connectedEnvironments.map((environment) => ({
    id: environment.environmentId,
    title: environment.environmentLabel,
    state: environment.environmentId === environmentId ? ("on" as const) : ("off" as const),
  }));
  // Outside the items: it is the way to another environment when this one isn't connected.
  const environmentPill =
    connectedEnvironments.length > 1 && term === "" ? (
      <View className="flex-row px-4 pb-1">
        <ListFilterMenu
          label={
            connectedEnvironments.find((environment) => environment.environmentId === environmentId)
              ?.environmentLabel ?? "Environment"
          }
          accessibilityLabel="Choose Linear environment"
          actions={environmentActions}
          onSelect={(id) => {
            const next = connectedEnvironments.find(
              (environment) => environment.environmentId === id,
            );
            if (next) setSelectedEnvironment(next.environmentId);
          }}
        />
      </View>
    ) : null;
  const renderItem = ({ item }: { readonly item: TabItem }) => {
    switch (item.type) {
      case "title":
        return <LinearSectionTitle>{item.text}</LinearSectionTitle>;
      case "team":
        return (
          <LinearTeamCard
            team={item.team}
            running={runningByTeam.get(item.team.id) ?? 0}
            onOpen={(teamId) => navigation.openScope({ team: teamId })}
          />
        );
      case "issue":
        return <LinearIssueRow issue={item.issue} context={rowContext} />;
      case "jump":
        return <JumpResultRow target={item.target} onOpen={openJumpTarget} />;
    }
  };
  const list = (
    <LinearList
      data={items}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.type}
      extraData={rowContext}
      estimatedItemSize={88}
      refreshing={refreshing}
      onRefresh={refresh}
      bottomInset={workspace.bottomClearance}
      renderItem={renderItem}
      ListHeaderComponent={
        <View>
          {environmentPill}
          {connected && degradation && term === "" ? (
            <LinearBanner degradation={degradation} onRetry={refresh} retrying={refreshing} />
          ) : null}
        </View>
      }
      ListEmptyComponent={
        state === "loading" ? (
          <LinearListSkeleton label="Loading Linear" />
        ) : connected ? (
          term !== "" ? (
            <Text className="px-8 py-12 text-center text-sm text-foreground-muted">
              {searching ? "Searching…" : "No results."}
            </Text>
          ) : (
            <View className="items-center gap-3 px-8 py-12">
              <LinearGlyph size={22} />
              <Text className="text-center text-sm text-foreground-muted">
                No teams in this Linear workspace.
              </Text>
            </View>
          )
        ) : (
          <LinearNotConnected state={state} onRetry={status.refresh} />
        )
      }
    />
  );
  return props.renderFrame ? props.renderFrame(list) : list;
}
