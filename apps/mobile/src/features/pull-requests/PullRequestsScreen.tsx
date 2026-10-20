import { Button } from "../../components/ui/Button";
import {
  applyPullRequestDraftFilterChange,
  parsePullRequestQuery,
} from "@t3tools/client-runtime/pull-request-query";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  Keyboard,
  Platform,
  RefreshControl,
  ScrollView,
  View,
  type ScrollViewProps,
} from "react-native";
import { ScrollViewMarker } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useWorkspaceState } from "../../state/workspace";
import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { PullRequestListRow } from "./PullRequestListRow";
import { PullRequestListFilters } from "./PullRequestListFilters";
import { usePullRequestList } from "./usePullRequestList";
import { usePullRequestListControls } from "./usePullRequestListControls";
import { usePullRequestListActions } from "./usePullRequestListActions";
import {
  filterPullRequestList,
  pullRequestListFacets,
  pullRequestListInput,
  pullRequestListRowsAreEqual,
  scopedPullRequestListKey as pullRequestKey,
  type EnvironmentPullRequestListEntry,
  withoutScratchProjectScope,
} from "./pullRequestList";
import { useDebouncedValue } from "../../state/queries";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

function PullRequestScrollView(props: ScrollViewProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView
        {...props}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  );
}

export function PullRequestsScreen(
  props: {
    readonly sidebar?: boolean;
    readonly selectedPullRequestKey?: string | null;
  } = {},
) {
  const navigation = useNavigation();
  const primaryColumn = use(NativePrimaryColumnContext);
  const workspace = useWorkspaceTabs()!;
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const insets = useSafeAreaInsets();
  const [initialOffset] = useState(() => workspace.getScrollOffset("pullRequests"));
  const listRef = useRef<LegendListRef>(null);
  const tab = workspace.state.tabs.pullRequests;
  const maintainVisiblePosition = useMemo(
    () => ({
      data: tab.searchMode === "resting",
      shouldRestorePosition: () => workspace.getScrollOffset("pullRequests") > 0,
    }),
    [tab.searchMode, workspace],
  );
  const debouncedQuery = useDebouncedValue(tab.query.trim(), 180);
  const query = tab.searchMode === "resting" ? "" : debouncedQuery;
  const typedQuery = tab.searchMode === "resting" ? "" : tab.query;
  const typedDraft = parsePullRequestQuery(typedQuery).filters.draft;
  const listControls = usePullRequestListControls();
  const selectedEnvironmentId = listControls.environmentId;
  const environmentId = environments.some((item) => item.environmentId === selectedEnvironmentId)
    ? selectedEnvironmentId
    : null;
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const selectPullRequest = useCallback(
    (item: EnvironmentPullRequestListEntry) => {
      Keyboard.dismiss();
      const params = {
        environmentId: String(item.environmentId),
        projectId: String(item.projectId),
        repository: item.repository,
        number: item.number,
        host: item.host,
        initialSummary: item,
      };
      if (Platform.OS === "android") selectAndroidWorkspace({ name: "PullRequest", params });
      else navigation.navigate("PullRequest", params);
    },
    [navigation, selectAndroidWorkspace],
  );
  const allProjects = useProjects();
  const savedControls = listControls.controlsFor(environmentId);
  const controls = useMemo(
    () => withoutScratchProjectScope(savedControls, allProjects),
    [allProjects, savedControls],
  );
  const targets = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            configs.get(environment.environmentId)?.environment.capabilities.pullRequests ===
              true &&
            (environmentId === null || environment.environmentId === environmentId) &&
            (!controls.projectEnvironmentId ||
              environment.environmentId === controls.projectEnvironmentId),
        )
        .sort((left, right) => left.environmentId.localeCompare(right.environmentId))
        .map((environment) => ({
          environmentId: environment.environmentId,
          input: pullRequestListInput(controls, query),
        })),
    [environments, environmentId, configs, controls, query],
  );
  const result = usePullRequestList(targets);
  const connectedTargets = targets.filter((target) =>
    environments.some(
      (environment) =>
        environment.environmentId === target.environmentId &&
        environment.connectionState === "connected",
    ),
  );
  const { actions, select, busyKey } = usePullRequestListActions(
    connectedTargets.map((target) => target.environmentId),
    result.updateEntry,
  );
  const sidebar = props.sidebar === true || primaryColumn !== null;
  const selectedKey = props.selectedPullRequestKey ?? primaryColumn?.selectedPullRequestKey;
  const connectedKey = connectedTargets.map((target) => target.environmentId).join("\n");
  const entries = useMemo(
    () =>
      filterPullRequestList(
        result.entries,
        controls,
        result.data?.viewers ?? {},
        query,
        result.data.localSearchHosts,
        new Set(connectedKey.split("\n")),
      ),
    [result.entries, controls, query, result.data, connectedKey],
  );
  const facets = useMemo(() => pullRequestListFacets(result.entries), [result.entries]);
  const [knownFacets, setKnownFacets] = useState({ environmentId, source: facets, ...facets });
  if (knownFacets.environmentId !== environmentId || knownFacets.source !== facets) {
    setKnownFacets((previous) => ({
      source: facets,
      environmentId,
      authors: [
        ...new Set([
          ...(previous.environmentId === environmentId ? previous.authors : []),
          ...facets.authors,
        ]),
      ].sort(),
      labels: [
        ...new Set([
          ...(previous.environmentId === environmentId ? previous.labels : []),
          ...facets.labels,
        ]),
      ].sort(),
    }));
  }
  const projects = allProjects.filter(
    (project) =>
      !project.isScratch && (environmentId === null || project.environmentId === environmentId),
  );
  const renderPullRequest = useCallback(
    ({ item }: { readonly item: EnvironmentPullRequestListEntry }) => (
      <PullRequestListRow
        item={item}
        onSelect={selectPullRequest}
        getActions={actions}
        onAction={select}
        busy={busyKey === pullRequestKey(item)}
        selected={selectedKey === pullRequestKey(item)}
        sidebar={sidebar}
      />
    ),
    [selectPullRequest, selectedKey, actions, select, busyKey, sidebar],
  );
  const previousSearchMode = useRef(tab.searchMode);
  useEffect(() => {
    const restoringSearch =
      previousSearchMode.current !== "resting" && tab.searchMode === "resting";
    previousSearchMode.current = tab.searchMode;
    if (restoringSearch)
      void listRef.current?.scrollToOffset({
        offset: tab.scrollOffset - (Platform.OS === "ios" ? insets.top : 0),
        animated: false,
      });
  }, [tab.searchMode, tab.scrollOffset, insets.top]);

  return (
    <View className={sidebar ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <LegendList
        ref={listRef}
        data={entries}
        extraData={`${selectedKey}:${busyKey}`}
        keyExtractor={pullRequestKey}
        itemsAreEqual={pullRequestListRowsAreEqual}
        estimatedItemSize={88}
        drawDistance={1_000}
        maintainVisibleContentPosition={result.continued ? maintainVisiblePosition : false}
        onEndReached={() => void result.loadMore()}
        onEndReachedThreshold={0.5}
        onViewableItemsChanged={result.onViewableItemsChanged}
        refreshControl={
          <RefreshControl
            refreshing={result.refreshing}
            onRefresh={() => void result.onRefresh()}
            // The list already accounts for the navigation header in its content inset.
            progressViewOffset={Platform.OS === "ios" ? 60 : undefined}
          />
        }
        alwaysBounceVertical
        // Android flashes a list's scrollbar whenever it becomes visible, which was every return
        // to this tab. The thread list shows none either.
        showsVerticalScrollIndicator={Platform.OS !== "android"}
        recycleItems
        renderScrollComponent={Platform.OS === "ios" ? PullRequestScrollView : undefined}
        contentInsetAdjustmentBehavior="never"
        contentInset={Platform.OS === "ios" ? { top: insets.top } : undefined}
        // A plain offset: LegendList adds the list header to an index-based restore, which
        // landed every return one header lower.
        initialScrollOffset={
          initialOffset > 0 ? initialOffset - (Platform.OS === "ios" ? insets.top : 0) : undefined
        }
        contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, workspace.bottomClearance),
        }}
        onScroll={(event) => {
          workspace.recordScrollOffset(
            "pullRequests",
            Math.max(
              0,
              event.nativeEvent.contentOffset.y + (Platform.OS === "ios" ? insets.top : 0),
            ),
          );
        }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={renderPullRequest}
        ListHeaderComponent={
          <>
            <PullRequestListFilters
              sidebar={sidebar}
              environments={environments.map((item) => ({
                id: String(item.environmentId),
                label: item.environmentLabel,
              }))}
              environmentId={environmentId}
              onEnvironmentChange={listControls.setEnvironmentId}
              value={
                typedDraft
                  ? { ...controls, filters: { ...controls.filters, draft: typedDraft } }
                  : controls
              }
              onChange={(next) => {
                const update = applyPullRequestDraftFilterChange(
                  typedQuery,
                  controls.filters,
                  next.filters,
                );
                listControls.setControls(environmentId, { ...next, filters: update.filters });
                if (update.query !== typedQuery)
                  workspace.dispatch({ type: "query", tab: "pullRequests", query: update.query });
                void listRef.current?.scrollToOffset({
                  offset: Platform.OS === "ios" ? -insets.top : 0,
                  animated: false,
                });
              }}
              authors={
                knownFacets.environmentId === environmentId ? knownFacets.authors : facets.authors
              }
              labels={
                knownFacets.environmentId === environmentId ? knownFacets.labels : facets.labels
              }
              projects={projects}
            />
            {result.data?.errors.length ? (
              <Text className="px-4 py-3 text-sm text-foreground-muted">
                {result.data.errors
                  .map(
                    (error) =>
                      `${error.projectTitle || environments.find((environment) => environment.environmentId === error.environmentId)?.environmentLabel || "Environment"}: ${error.message}`,
                  )
                  .join("\n")}
              </Text>
            ) : null}
          </>
        }
        ListFooterComponent={
          result.loadingMore ? (
            <View className="items-center py-5">
              <AppActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel="Loading more pull requests"
              />
            </View>
          ) : result.loadMoreError ? (
            <View className="items-center gap-2 px-8 py-4">
              <Text className="text-xs text-foreground-muted">{result.loadMoreError}</Text>
              <Button
                label="Try again"
                accessibilityLabel="Retry loading more pull requests"
                onPress={() => void result.loadMore(true)}
              />
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          result.isPending && connectedTargets.length > 0 ? (
            <View className="items-center py-12">
              <AppActivityIndicator colorClassName="accent-icon" />
            </View>
          ) : (
            <View className="px-8 py-12">
              <EmptyState
                title={
                  result.error
                    ? "Couldn't load pull requests"
                    : targets.length && connectedTargets.length === 0
                      ? "Environment offline"
                      : targets.length
                        ? query
                          ? "No results"
                          : "No matching pull requests"
                        : "Connect an environment"
                }
                detail={
                  result.error ??
                  (targets.length && connectedTargets.length === 0
                    ? "Reconnect to load pull requests that aren't saved on this device."
                    : targets.length
                      ? "Pull requests from the selected environments' projects appear here."
                      : "Add an environment in Settings to browse its pull requests.")
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
