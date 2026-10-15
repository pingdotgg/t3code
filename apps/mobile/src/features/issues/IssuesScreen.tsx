import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { offeredIssueInvolvements } from "@t3tools/client-runtime/state/issues";
import { ProjectId, type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { use, useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ScrollViewProps,
} from "react-native";
import { ScrollViewMarker } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useWorkspaceState } from "../../state/workspace";
import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useDebouncedValue } from "../../state/queries";
import { issueEnvironment } from "../../state/issues";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { IssueListFilters } from "./IssueListFilters";
import { IssueListRow } from "./IssueListRow";
import {
  ISSUE_LIST_PAGE_SIZE,
  issueCreateScopes,
  issueListNotices,
  issueListRows,
  issueListTrackers,
  scopedIssueKey,
  type EnvironmentIssueEntry,
} from "./issueList";
import { useIssueList } from "./useIssueList";
import { useIssueListControls } from "./useIssueListControls";
import { useOpenIssue } from "./useOpenIssue";

const creatableFamily = Atom.family((key: string) =>
  Atom.make((get) =>
    key
      .split("\n")
      .filter((environmentId) =>
        get(issueEnvironment.create.permissionAtom(environmentId as EnvironmentId)),
      ),
  ),
);

function IssueScrollView(props: ScrollViewProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollViewMarker>
      <ScrollView
        {...props}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  );
}

export function IssuesScreen(
  props: { readonly sidebar?: boolean; readonly selectedIssueKey?: string | null } = {},
) {
  const navigation = useNavigation();
  const primaryColumn = use(NativePrimaryColumnContext);
  const workspace = useWorkspaceTabs()!;
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const insets = useSafeAreaInsets();
  const [initialOffset] = useState(() => workspace.getScrollOffset("issues"));
  const listRef = useRef<LegendListRef>(null);
  const tab = workspace.state.tabs.issues;
  const debouncedQuery = useDebouncedValue(tab.query.trim(), 300);
  const query = tab.searchMode === "resting" ? "" : debouncedQuery.slice(0, 200);
  const { controls, setControls } = useIssueListControls();
  const allProjects = useProjects();
  const capable = environments.filter(
    (environment) =>
      configs.get(environment.environmentId)?.environment.capabilities.issues === true,
  );
  const targets = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            configs.get(environment.environmentId)?.environment.capabilities.issues === true &&
            (controls.environmentId === null ||
              environment.environmentId === controls.environmentId) &&
            (!controls.projectEnvironmentId ||
              environment.environmentId === controls.projectEnvironmentId),
        )
        .sort((left, right) => left.environmentId.localeCompare(right.environmentId))
        .map((environment) => ({
          environmentId: environment.environmentId,
          input: {
            state: controls.state,
            involvement: controls.involvement,
            limit: ISSUE_LIST_PAGE_SIZE,
            ...(controls.host ? { host: controls.host } : {}),
            ...(controls.projectId ? { projectId: ProjectId.make(controls.projectId) } : {}),
            ...(query ? { query } : {}),
          },
        })),
    [environments, configs, controls, query],
  );
  const result = useIssueList(targets);
  const connectedKey = environments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .join("\n");
  const connected = useMemo(() => new Set(connectedKey.split("\n")), [connectedKey]);
  const creatable = useAtomValue(creatableFamily(connectedKey));
  const connectedTargets = targets.filter((target) => connected.has(target.environmentId));
  const entries = useMemo(() => issueListRows(result.lists, query), [result.lists, query]);
  const notices = useMemo(() => issueListNotices(result.lists), [result.lists]);
  const trackers = useMemo(() => issueListTrackers(result.lists), [result.lists]);
  const involvements = useMemo(
    () => offeredIssueInvolvements(trackers, controls.involvement),
    [trackers, controls.involvement],
  );
  const projects = allProjects.filter(
    (project) =>
      capable.some((environment) => environment.environmentId === project.environmentId) &&
      (controls.environmentId === null || project.environmentId === controls.environmentId),
  );
  const createScopes = useMemo(
    () =>
      issueCreateScopes(
        result.lists,
        allProjects,
        controls.projectId && controls.projectEnvironmentId
          ? {
              environmentId: controls.projectEnvironmentId as EnvironmentId,
              projectId: controls.projectId,
            }
          : undefined,
      ).filter(
        (scope) => connected.has(scope.environmentId) && creatable.includes(scope.environmentId),
      ),
    [result.lists, allProjects, controls, connected, creatable],
  );
  const openIssue = useOpenIssue();
  const selectIssue = useCallback(
    (item: EnvironmentIssueEntry) =>
      openIssue({
        environmentId: item.environmentId,
        projectId: item.projectId,
        tracker: item.tracker,
        host: item.host,
        scope: item.scope,
        key: item.key,
        displayKey: item.displayKey,
      }),
    [openIssue],
  );
  const sidebar = props.sidebar === true || primaryColumn !== null;
  const selectedKey = props.selectedIssueKey ?? primaryColumn?.selectedIssueKey;
  const renderIssue = useCallback(
    ({ item }: { readonly item: EnvironmentIssueEntry }) => (
      <IssueListRow
        item={item}
        onSelect={selectIssue}
        selected={selectedKey === scopedIssueKey(item)}
        sidebar={sidebar}
      />
    ),
    [selectIssue, selectedKey, sidebar],
  );
  const environmentLabel = (environmentId: string) =>
    environments.find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? "Environment";
  const errors = [
    ...result.errors.map((error) => ({
      key: `environment:${error.environmentId}`,
      title: environmentLabel(error.environmentId),
      message: error.message,
    })),
    ...notices,
  ];

  return (
    <View className={sidebar ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <LegendList
        ref={listRef}
        data={entries}
        extraData={selectedKey}
        keyExtractor={scopedIssueKey}
        estimatedItemSize={88}
        drawDistance={1_000}
        refreshControl={
          <RefreshControl
            refreshing={result.refreshing}
            onRefresh={() => void result.onRefresh()}
            progressViewOffset={Platform.OS === "ios" ? 60 : undefined}
          />
        }
        alwaysBounceVertical
        recycleItems
        renderScrollComponent={Platform.OS === "ios" ? IssueScrollView : undefined}
        contentInsetAdjustmentBehavior="never"
        contentInset={Platform.OS === "ios" ? { top: insets.top } : undefined}
        initialScrollOffset={
          initialOffset > 0 ? initialOffset - (Platform.OS === "ios" ? insets.top : 0) : undefined
        }
        contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, workspace.bottomClearance),
        }}
        onScroll={(event) =>
          workspace.recordScrollOffset(
            "issues",
            Math.max(
              0,
              event.nativeEvent.contentOffset.y + (Platform.OS === "ios" ? insets.top : 0),
            ),
          )
        }
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={renderIssue}
        ListHeaderComponent={
          <>
            <IssueListFilters
              environments={capable.map((item) => ({
                id: String(item.environmentId),
                label: item.environmentLabel,
              }))}
              value={controls}
              onChange={(next) => {
                setControls(next);
                void listRef.current?.scrollToOffset({
                  offset: Platform.OS === "ios" ? -insets.top : 0,
                  animated: false,
                });
              }}
              involvements={involvements}
              trackers={trackers}
              projects={projects}
              onCreate={
                createScopes.length
                  ? () => navigation.navigate("IssueCreate", { scopes: createScopes })
                  : null
              }
            />
            {errors.length ? (
              <View className="gap-1 px-4 pb-3">
                {errors.map((error) => (
                  <Text key={error.key} className="text-sm text-foreground-muted">
                    {error.title}: {error.message}
                  </Text>
                ))}
              </View>
            ) : null}
          </>
        }
        ListFooterComponent={
          result.loadingMore ? (
            <View className="items-center py-5">
              <ActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel="Loading more issues"
              />
            </View>
          ) : result.loadMoreError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading more issues"
              onPress={() => void result.loadMore(true)}
              className="items-center gap-2 px-8 py-4"
            >
              <Text className="text-xs text-foreground-muted">{result.loadMoreError}</Text>
              <Text className="text-sm font-t3-medium text-primary-text">Try again</Text>
            </Pressable>
          ) : result.hasMore && connectedTargets.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Load more issues"
              onPress={() => void result.loadMore()}
              className="items-center px-8 py-4"
            >
              <Text className="text-sm font-t3-medium text-primary-text">Load more</Text>
            </Pressable>
          ) : undefined
        }
        ListEmptyComponent={
          result.isPending && connectedTargets.length > 0 ? (
            <View className="items-center py-12">
              <ActivityIndicator colorClassName="accent-icon" />
            </View>
          ) : (
            <View className="px-8 py-12">
              <EmptyState
                title={
                  environments.length === 0
                    ? "Connect an environment"
                    : capable.length === 0
                      ? "Issues unavailable"
                      : targets.length && connectedTargets.length === 0
                        ? "Environment offline"
                        : result.lists.length && trackers.length === 0
                          ? "No trackers to read"
                          : query
                            ? "No results"
                            : "No matching issues"
                }
                detail={
                  environments.length === 0
                    ? "Add an environment in Settings to browse its issues."
                    : capable.length === 0
                      ? "Update this environment's T3 Code server to browse issues."
                      : targets.length && connectedTargets.length === 0
                        ? "Reconnect to load issues."
                        : result.lists.length && trackers.length === 0
                          ? "Add a project on a supported tracker, or connect Linear or Jira in Settings > Source control on desktop or web."
                          : "Issues from the selected environments' projects appear here."
                }
                variant="plain"
              />
            </View>
          )
        }
      />
    </View>
  );
}
