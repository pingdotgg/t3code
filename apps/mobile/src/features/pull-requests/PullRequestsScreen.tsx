import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ActivityIndicator,
  Keyboard,
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
import { PullRequestListRow } from "./PullRequestListRow";
import { PullRequestListFilters } from "./PullRequestListFilters";
import { pullRequestListControlsAtom, usePullRequestList } from "./usePullRequestList";
import { usePullRequestListActions } from "./usePullRequestListActions";
import {
  filterPullRequestList,
  pullRequestListFacets,
  pullRequestListRowsAreEqual,
  scopedPullRequestListKey as pullRequestKey,
  type EnvironmentPullRequestListEntry,
  PR_LIST_PAGE_SIZE,
} from "./pullRequestList";
import { useDebouncedValue } from "../../state/queries";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

function PullRequestScrollView(props: ScrollViewProps) {
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

export function PullRequestsScreen() {
  const navigation = useNavigation();
  const primaryColumn = use(NativePrimaryColumnContext);
  const workspace = useWorkspaceTabs()!;
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const insets = useSafeAreaInsets();
  const [initialOffset] = useState(() => workspace.getScrollOffset("pullRequests"));
  const [initialAnchor] = useState(() => workspace.getScrollAnchor("pullRequests"));
  const listRef = useRef<LegendListRef>(null);
  const tab = workspace.state.tabs.pullRequests;
  const maintainVisiblePosition = useMemo(
    () => ({
      data: tab.searchMode === "resting",
      // At the top, reveal new PRs without pushing the filter strip out of view.
      shouldRestorePosition: () => workspace.getScrollOffset("pullRequests") > 0,
    }),
    [tab.searchMode, workspace],
  );
  const debouncedQuery = useDebouncedValue(tab.query.trim(), 180);
  // Dismissal must restore the cached unfiltered list before restoring its offset.
  const query = tab.searchMode === "resting" ? "" : debouncedQuery;
  const selectedEnvironmentId = workspace.pullRequestEnvironmentId;
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
  const controlsAtom = pullRequestListControlsAtom(environmentId ?? "");
  const controls = useAtomValue(controlsAtom);
  const setControls = useAtomSet(controlsAtom);
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
          input: {
            state: controls.state,
            involvement: controls.involvement,
            filters: controls.filters,
            limit: PR_LIST_PAGE_SIZE,
            ...(controls.projectId ? { projectId: ProjectId.make(controls.projectId) } : {}),
            ...(query ? { query } : {}),
          },
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
  const selectedKey = primaryColumn?.selectedPullRequestKey;
  const entries = useMemo(
    () =>
      filterPullRequestList(
        result.entries,
        controls,
        result.data?.viewers ?? {},
        query,
        result.data.localSearchHosts,
      ),
    [result.entries, controls, query, result.data],
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
  const projects = useProjects().filter(
    (project) => environmentId === null || project.environmentId === environmentId,
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
      />
    ),
    [selectPullRequest, selectedKey, actions, select, busyKey],
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
  const initialIndex = initialAnchor
    ? entries.findIndex((entry) => pullRequestKey(entry) === initialAnchor.key)
    : -1;

  return (
    <View className={primaryColumn ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <LegendList
        ref={listRef}
        data={entries}
        extraData={`${primaryColumn?.selectedPullRequestKey}:${busyKey}`}
        keyExtractor={pullRequestKey}
        itemsAreEqual={pullRequestListRowsAreEqual}
        // Default-size rows measure about 78pt with one title line and 98pt with two.
        estimatedItemSize={88}
        // Build roughly a screen ahead so a fling reaches already-mounted rows.
        drawDistance={1_000}
        maintainVisibleContentPosition={result.continued ? maintainVisiblePosition : false}
        onEndReached={() => void result.loadMore()}
        onEndReachedThreshold={0.5}
        onViewableItemsChanged={result.onViewableItemsChanged}
        refreshControl={
          <RefreshControl
            refreshing={result.refreshing}
            onRefresh={() => void result.onRefresh()}
            // Place the 60pt native refresh control in the revealed pull-down space.
            // The list already accounts for the navigation header in its content inset.
            progressViewOffset={Platform.OS === "ios" ? 60 : undefined}
          />
        }
        alwaysBounceVertical
        recycleItems
        renderScrollComponent={Platform.OS === "ios" ? PullRequestScrollView : undefined}
        contentInsetAdjustmentBehavior="never"
        contentInset={Platform.OS === "ios" ? { top: insets.top } : undefined}
        initialScrollOffset={
          !initialAnchor && initialOffset > 0
            ? initialOffset - (Platform.OS === "ios" ? insets.top : 0)
            : undefined
        }
        initialScrollIndex={
          initialIndex >= 0 && initialAnchor
            ? { index: initialIndex, viewOffset: initialAnchor.viewOffset, viewPosition: 0 }
            : undefined
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
          const list = listRef.current?.getState();
          const item = list ? entries[list.start] : undefined;
          if (list && item)
            workspace.recordScrollAnchor("pullRequests", {
              key: pullRequestKey(item),
              viewOffset: list.positionAtIndex(list.start) - event.nativeEvent.contentOffset.y,
            });
        }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={renderPullRequest}
        ListHeaderComponent={
          <>
            <PullRequestListFilters
              environments={environments.map((item) => ({
                id: String(item.environmentId),
                label: item.environmentLabel,
              }))}
              environmentId={environmentId}
              onEnvironmentChange={workspace.setPullRequestEnvironmentId}
              value={controls}
              onChange={(next) => {
                setControls(next);
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
              <ActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel="Loading more pull requests"
              />
            </View>
          ) : result.loadMoreError ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading more pull requests"
              onPress={() => void result.loadMore(true)}
              className="items-center gap-2 px-8 py-4"
            >
              <Text className="text-xs text-foreground-muted">{result.loadMoreError}</Text>
              <Text className="text-sm font-t3-medium text-link">Try again</Text>
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
