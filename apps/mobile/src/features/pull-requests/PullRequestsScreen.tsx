import { Button } from "../../components/ui/Button";
import {
  applyPullRequestDraftFilterChange,
  parsePullRequestQuery,
} from "@t3tools/client-runtime/pull-request-query";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import { use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ScrollViewProps,
} from "react-native";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useWorkspaceState } from "../../state/workspace";
import { useProjects } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { PullRequestListRow } from "./PullRequestListRow";
import {
  PullRequestListFilters,
  usePullRequestListFilters,
  type PullRequestFilterMenu,
} from "./PullRequestListFilters";
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
  pullRequestProjectChoices,
} from "./pullRequestList";
import { useDebouncedValue } from "../../state/queries";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

function PullRequestScrollView(props: ScrollViewProps) {
  return (
    <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView {...props} />
    </ScrollViewMarker>
  );
}

function PullRequestListError(props: { readonly message: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.message}
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((value) => !value)}
      // A long press selects the text; collapsing under that selection crashes Android's
      // smart-select animation, so it must not also count as a press.
      onLongPress={() => undefined}
      className="min-h-11 flex-row items-center gap-3 px-4 py-2.5 active:opacity-70"
    >
      <SymbolView
        name="exclamationmark.triangle"
        size={18}
        tintColorClassName="accent-icon-muted"
      />
      <Text
        selectable={expanded}
        numberOfLines={expanded ? undefined : 1}
        ellipsizeMode="tail"
        className="min-w-0 flex-1 text-sm text-foreground-muted"
      >
        {props.message}
      </Text>
      <SymbolView
        name={expanded ? "chevron.up" : "chevron.down"}
        size={11}
        tintColorClassName="accent-icon-muted"
      />
    </Pressable>
  );
}

export function PullRequestsScreen(
  props: {
    readonly sidebar?: boolean;
    readonly selectedPullRequestKey?: string | null;
    /**
     * Places the list under a header that opens the full filter menu (the Android toolbar). The
     * filters live here, so the header gets them in the same render as the list.
     */
    readonly renderFrame?: (filters: PullRequestFilterMenu | null, list: ReactNode) => ReactNode;
  } = {},
) {
  const navigation = useNavigation();
  const primaryColumn = use(NativePrimaryColumnContext);
  const workspace = useWorkspaceTabs()!;
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const insets = useSafeAreaInsets();
  // UIKit insets the list by its column's safe area, which this context can report as 0.
  const columnSafeBottom = useNativeColumnLayoutMetrics()?.safeArea.bottom;
  const bottomSafeArea =
    Platform.OS === "ios" ? (columnSafeBottom ?? insets.bottom) : insets.bottom;
  const listRef = useRef<LegendListRef>(null);
  const tab = workspace.state.tabs.pullRequests;
  const [initialScrollOffset] = useState(() => workspace.getScrollOffset("pullRequests"));
  // Cancelling search restores the offset recorded when search opened. The
  // toolbar that cancels has no handle on this list, so the list scrolls itself
  // once it sees the tab come back to resting.
  const previousSearchMode = useRef(tab.searchMode);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to the offset saved when search opened once the tab returns to resting
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
  const maintainVisiblePosition = {
    data: tab.searchMode === "resting",
    shouldRestorePosition: () => workspace.getScrollOffset("pullRequests") > 0,
  };
  const debouncedQuery = useDebouncedValue(tab.query.trim(), 180);
  const query = tab.searchMode === "resting" ? "" : debouncedQuery;
  const typedQuery = tab.searchMode === "resting" ? "" : tab.query;
  const typedDraft = parsePullRequestQuery(typedQuery).filters.draft;
  const listControls = usePullRequestListControls();
  const selectedEnvironmentId = listControls.environmentId;
  const environmentId = environments.some((item) => item.environmentId === selectedEnvironmentId)
    ? selectedEnvironmentId
    : null;
  const selectDetail = useSelectWorkspaceDetail();
  const selectPullRequest = (item: EnvironmentPullRequestListEntry) => {
    Keyboard.dismiss();
    const params = {
      environmentId: String(item.environmentId),
      projectId: String(item.projectId),
      repository: item.repository,
      number: item.number,
      host: item.host,
      initialSummary: item,
    };
    selectDetail({ name: "PullRequest", params });
  };
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
            configs.get(environment.environmentId) !== undefined &&
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
  const facets = pullRequestListFacets(result.entries);
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
      labelColors: {
        ...facets.labelColors,
        ...(previous.environmentId === environmentId ? previous.labelColors : {}),
      },
    }));
  }
  const labelColors =
    knownFacets.environmentId === environmentId ? knownFacets.labelColors : facets.labelColors;
  const projects = pullRequestProjectChoices(allProjects, {
    environmentId,
    controls,
    environmentLabels: new Map(
      environments.map((item) => [item.environmentId, item.environmentLabel]),
    ),
    servesPullRequests: (id) => configs.get(id)?.environment.capabilities.pullRequests === true,
  });
  const filters = usePullRequestListFilters({
    environments: environments.map((item) => ({
      id: String(item.environmentId),
      label: item.environmentLabel,
    })),
    environmentId,
    onEnvironmentChange: listControls.setEnvironmentId,
    value: typedDraft
      ? { ...controls, filters: { ...controls.filters, draft: typedDraft } }
      : controls,
    onChange: (next) => {
      const update = applyPullRequestDraftFilterChange(typedQuery, controls.filters, next.filters);
      listControls.setControls(environmentId, { ...next, filters: update.filters });
      if (update.query !== typedQuery)
        workspace.dispatch({ type: "query", tab: "pullRequests", query: update.query });
      void listRef.current?.scrollToOffset({
        offset: Platform.OS === "ios" ? -insets.top : 0,
        animated: false,
      });
    },
    authors: knownFacets.environmentId === environmentId ? knownFacets.authors : facets.authors,
    labels: knownFacets.environmentId === environmentId ? knownFacets.labels : facets.labels,
    labelColors,
    projects,
    onSearch: (kind) =>
      navigation.navigate("PullRequestFilterSearch", {
        kind,
        environmentId,
        environmentIds: targets.map((target) => String(target.environmentId)),
        suggestions: knownFacets.environmentId === environmentId ? knownFacets[kind] : facets[kind],
        labelColors,
      }),
  });
  const renderPullRequest = ({ item }: { readonly item: EnvironmentPullRequestListEntry }) => (
    <PullRequestListRow
      item={item}
      onSelect={selectPullRequest}
      getActions={actions}
      onAction={select}
      busy={busyKey === pullRequestKey(item)}
      selected={selectedKey === pullRequestKey(item)}
      sidebar={sidebar}
    />
  );
  const list = (
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
        // UIKit owns the bar's inset, so a minimizing bar and a resized column move
        // the list in the same frame as the bar.
        contentInsetAdjustmentBehavior="automatic"
        // A plain offset: LegendList adds the list header to an index-based restore, which
        // landed every return one header lower.
        initialScrollOffset={
          initialScrollOffset > 0
            ? initialScrollOffset - (Platform.OS === "ios" ? insets.top : 0)
            : undefined
        }
        contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
        contentContainerStyle={{
          paddingBottom:
            Math.max(bottomSafeArea, workspace.bottomClearance) -
            (Platform.OS === "ios" ? bottomSafeArea : 0),
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
            <PullRequestListFilters sidebar={sidebar} filters={filters} />
            {result.data?.errors.length ? (
              <View key={JSON.stringify(targets)}>
                {result.data.errors.map((error) => (
                  <PullRequestListError
                    key={`${error.environmentId} ${error.projectTitle} ${error.message}`}
                    message={`${error.projectTitle || environments.find((environment) => environment.environmentId === error.environmentId)?.environmentLabel || "Environment"}: ${error.message}`}
                  />
                ))}
              </View>
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
          ) : result.hasMore ? (
            // A filtered page can be too short to scroll, which leaves nothing to reach the end of.
            <View className="items-center py-4">
              <Button
                label="Load more"
                accessibilityLabel="Load more pull requests"
                onPress={() => void result.loadMore()}
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
  return props.renderFrame ? props.renderFrame(filters.headerMenu, list) : list;
}
