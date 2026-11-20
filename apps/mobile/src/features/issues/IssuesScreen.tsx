import { useAtom, useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import {
  continueIssuePage,
  groupIssues,
  holdIssuePages,
  issueFilterScopes,
  issueOrder,
  type EnvironmentIssueEntry,
  type HeldIssuePage,
} from "@t3tools/client-runtime/issue-list";
import { issueTrackerDetailText } from "@t3tools/client-runtime/state/issue-trackers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListInput,
  IssueListSort,
  IssueListState,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react-native";
import { use, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useNavigation } from "@react-navigation/native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { usePaneRole } from "../../components/ui/Pane";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { m, type MessageResolver } from "../../i18n/messages";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { useProjects } from "../../state/entities";
import { issueEnvironment, useIssueList } from "../../state/issues";
import { useDebouncedValue } from "../../state/queries";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { useSearchScrollRestoration } from "../layout/workspace/useSearchScrollRestoration";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { issueParamsKey } from "./issueParams";
import { IssueListRow } from "./IssueListRow";
import type { PullRequestFilterMenu } from "../pull-requests/PullRequestListFilters";
import { issueListFiltersAtom } from "./issueListFilters";
import { issueViewMatches } from "./issueSavedViews";
import { SavedViewsMenu } from "../layout/workspace/SavedViewsMenu";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const DEFAULT_ISSUE_LIST_INPUT = { state: "open", involvement: "all", limit: 50 } as const;
const STATES = {
  open: msg("Open", { $context: "issue state" }),
  closed: msg("Closed", { $context: "issue state" }),
  all: msg("All states"),
} as const satisfies Record<IssueListState, string>;
const INVOLVEMENT = {
  all: msg("Everyone", { $context: "issue filter" }),
  assigned: msg("Assigned to you"),
  authored: msg("Opened by you"),
  mentioned: msg("Mentioning you"),
} as const satisfies Record<IssueInvolvement, string>;
const SORTS = {
  updated: msg("Recently updated"),
  created: msg("Newest", { $context: "sort order" }),
} as const satisfies Record<IssueListSort, string>;
// A 12dp inset keeps 16dp chips concentric with Android's 28dp ScreenContent corner.
const FILTER_ROW_STYLE =
  Platform.OS === "android"
    ? { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8, gap: 8 }
    : { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10, gap: 8 };

function choices<Value extends string>(
  options: Readonly<Record<Value, string>>,
  selected: Value,
  resolve: MessageResolver,
  /** Prefixes the ids, for a menu that holds more than one set of choices. */
  field?: string,
) {
  return (Object.entries(options) as Array<[Value, string]>).map(([id, title]) => ({
    id: field ? `${field}:${id}` : id,
    title: resolve(title),
    state: id === selected ? ("on" as const) : ("off" as const),
  }));
}

const rowKey = (item: EnvironmentIssueEntry) =>
  issueParamsKey({
    environmentId: item.environmentId,
    projectId: item.projectId,
    host: item.host,
    scope: item.scope,
    issueKey: item.key,
  });

export function IssuesScreen(
  props: {
    readonly sidebar?: boolean;
    readonly selectedIssueKey?: string | null;
    /** Places the list under a header of the caller's (the Android toolbar). */
    readonly renderFrame?: (filters: PullRequestFilterMenu | null, list: ReactNode) => ReactNode;
  } = {},
) {
  const gt = useGT();
  const messages = useMessages();
  const primaryColumn = use(NativePrimaryColumnContext);
  const workspace = useWorkspaceTabs()!;
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  // UIKit insets the list by its column's safe area, which this context can report as 0.
  const columnSafeBottom = useNativeColumnLayoutMetrics()?.safeArea.bottom;
  const bottomSafeArea =
    Platform.OS === "ios" ? (columnSafeBottom ?? insets.bottom) : insets.bottom;
  const listRef = useRef<LegendListRef>(null);
  const tab = workspace.state.tabs.issues;
  const [initialScrollOffset] = useState(() => workspace.getScrollOffset("issues"));
  useSearchScrollRestoration(tab.searchMode, () => {
    void listRef.current?.scrollToOffset({
      offset: tab.scrollOffset - contentTopInset,
      animated: false,
    });
  });
  const debouncedQuery = useDebouncedValue(tab.query.trim(), 300);
  const query = tab.searchMode === "resting" ? "" : debouncedQuery;
  const [state, setState] = useState<IssueListState>("open");
  const [involvement, setInvolvement] = useState<IssueInvolvement>("all");
  const navigation = useNavigation();
  const [{ labels, assignee }, setFilters] = useAtom(issueListFiltersAtom);
  const { themeAppearance } = useAppearancePreferences();
  const [sort, setSort] = useState<IssueListSort>("updated");
  const listInput: IssueListInput = {
    ...DEFAULT_ISSUE_LIST_INPUT,
    state,
    involvement,
    ...(query ? { query } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(assignee === null ? {} : { assignee: assignee.login }),
    ...(sort === "updated" ? {} : { sort }),
  };
  const capable = environments.filter(
    (environment) =>
      configs.get(environment.environmentId)?.environment.capabilities.issues === true,
  );
  const connected = capable.filter((environment) => environment.connectionState === "connected");
  const targets = connected
    .map((environment) => ({ environmentId: environment.environmentId, input: listInput }))
    .sort((left, right) => left.environmentId.localeCompare(right.environmentId));
  const list = useIssueList(targets);

  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, HeldIssuePage>>(new Map());
  const held = holdIssuePages(list.answers, pages);
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const loading = useRef(false);
  const continuable = [...held].filter(([, page]) => Object.keys(page.nextCursors).length > 0);
  const moreFailure = [...held.values()].find((page) => page.moreFailure)?.moreFailure ?? null;
  const loadMore = async (retry = false) => {
    if (loading.current || (moreFailure !== null && !retry)) return;
    loading.current = true;
    setLoadingMore(true);
    const loaded = await Promise.all(
      continuable.map(async ([environmentId, page]) => {
        const result = await loadPage({
          environmentId,
          input: { ...listInput, cursors: page.nextCursors },
        });
        const failure = AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
        return [
          environmentId,
          continueIssuePage(
            page,
            AsyncResult.isFailure(result)
              ? {
                  failure:
                    failure instanceof Error ? failure.message : m(msg("The next page failed.")),
                }
              : result.value,
          ),
        ] as const;
      }),
    );
    loading.current = false;
    setLoadingMore(false);
    setPages(new Map([...held, ...loaded]));
  };

  const groups = groupIssues(held, query, projects, sort);
  const entries = groups.flatMap((group) => group.rows).sort(issueOrder(sort));
  const filterScopes = issueFilterScopes(held, projects);
  const notices = [
    // An environment that failed while another answered: its issues are missing from the rows.
    ...(entries.length > 0 && list.error ? [list.error] : []),
    ...groups.flatMap((group) => [
      ...(group.tracker.configured
        ? []
        : [
            `${group.tracker.host}: ${group.tracker.detail === null ? gt("This tracker cannot be read.") : issueTrackerDetailText(group.tracker.detail, messages)}`,
          ]),
      ...group.errors.map((error) => `${error.projectTitle}: ${error.message}`),
    ]),
  ];

  const paneRole = usePaneRole();
  const sidebar = props.sidebar === true || (primaryColumn !== null && paneRole === "sidebar");
  const selectedKey = props.selectedIssueKey ?? primaryColumn?.selectedIssueKey;
  const selectDetail = useSelectWorkspaceDetail();
  const selectIssue = (item: EnvironmentIssueEntry) => {
    Keyboard.dismiss();
    selectDetail({
      name: "Issue",
      params: {
        environmentId: String(item.environmentId),
        projectId: String(item.projectId),
        tracker: item.tracker,
        host: item.host,
        scope: item.scope,
        issueKey: item.key,
        initialSummary: item,
      },
    });
  };
  const scrollToTop = () =>
    void listRef.current?.scrollToOffset({ offset: -contentTopInset, animated: false });

  const customized =
    state !== "open" ||
    involvement !== "all" ||
    sort !== "updated" ||
    labels.length > 0 ||
    assignee !== null;
  // The Android header's filter button opens every filter, as the pull request list's does.
  const headerMenu: PullRequestFilterMenu | null =
    Platform.OS === "android"
      ? {
          actions: [
            {
              id: "state",
              title: gt("State", { $context: "issue state filter" }),
              subactions: choices(STATES, state, messages, "state"),
            },
            {
              id: "involvement",
              title: gt("Involvement"),
              subactions: choices(INVOLVEMENT, involvement, messages, "involvement"),
            },
            {
              id: "labels",
              title:
                labels.length === 0
                  ? gt("Labels…")
                  : gt("Labels ({count})…", { count: labels.length }),
            },
            {
              id: "assignee",
              title:
                assignee === null
                  ? gt("Assignee…")
                  : gt("Assignee: {name}…", { name: assignee.name ?? assignee.login }),
            },
            {
              id: "sort",
              title: gt("Sort", { $context: "noun, sort order menu" }),
              subactions: choices(SORTS, sort, messages, "sort"),
            },
            {
              id: "reset",
              title: gt("Reset filters"),
              attributes: { disabled: !customized },
            },
          ],
          onSelect: (id) => {
            const [field, value] = id.split(":");
            if (field === "state") setState(value as IssueListState);
            if (field === "involvement") setInvolvement(value as IssueInvolvement);
            if (field === "sort") setSort(value as IssueListSort);
            if (field === "labels" || field === "assignee")
              navigation.navigate("IssueFilterSearch", { kind: field, scopes: filterScopes });
            if (field === "reset") {
              setState("open");
              setInvolvement("all");
              setSort("updated");
              setFilters({ labels: [], assignee: null });
            }
          },
          customized,
        }
      : null;

  const content = (
    <View className={sidebar ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <LegendList
        ref={listRef}
        data={entries}
        extraData={selectedKey}
        keyExtractor={rowKey}
        estimatedItemSize={84}
        drawDistance={1_000}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={list.isPending && list.answers.length > 0}
            onRefresh={list.refresh}
            // The list already accounts for the navigation header in its content inset.
            progressViewOffset={Platform.OS === "ios" ? 60 : undefined}
          />
        }
        alwaysBounceVertical
        showsVerticalScrollIndicator={Platform.OS !== "android"}
        recycleItems
        renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
        contentInsetAdjustmentBehavior="never"
        contentInset={Platform.OS === "ios" ? { top: contentTopInset } : undefined}
        initialScrollOffset={
          initialScrollOffset > 0 ? initialScrollOffset - contentTopInset : undefined
        }
        contentContainerStyle={{
          paddingBottom: Math.max(bottomSafeArea, workspace.bottomClearance),
        }}
        onScroll={(event) => {
          workspace.recordScrollOffset(
            "issues",
            Math.max(0, event.nativeEvent.contentOffset.y + contentTopInset),
          );
        }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <IssueListRow
            item={item}
            onSelect={selectIssue}
            selected={selectedKey === rowKey(item)}
            sidebar={sidebar}
          />
        )}
        // Lifted above the rows so an iOS filter menu's dismissal morph is not covered.
        ListHeaderComponentStyle={{ zIndex: 1 }}
        ListHeaderComponent={
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ overflow: "visible" }}
              contentContainerStyle={
                sidebar && Platform.OS === "android"
                  ? { ...FILTER_ROW_STYLE, paddingHorizontal: 20 }
                  : FILTER_ROW_STYLE
              }
            >
              <SavedViewsMenu
                read={(preferences) => preferences.issueSavedViews}
                write={(issueSavedViews) => ({ issueSavedViews })}
                list="issue"
                suggestedName={involvement === "assigned" ? gt("Issues Assigned to Me") : ""}
                matches={issueViewMatches}
                scope={{
                  query: tab.searchMode === "resting" ? "" : tab.query,
                  state,
                  involvement,
                  sort,
                  labels,
                  assignee,
                }}
                onApply={(view) => {
                  setState(view.state);
                  setInvolvement(view.involvement);
                  setSort(view.sort);
                  setFilters({ labels: view.labels, assignee: view.assignee });
                  const viewQuery = view.query.trim();
                  workspace.dispatch(
                    viewQuery
                      ? { type: "search", tab: "issues" }
                      : { type: "cancel", tab: "issues", scrollToTop: true },
                  );
                  workspace.dispatch({ type: "query", tab: "issues", query: viewQuery });
                  scrollToTop();
                }}
              />
              <ListFilterMenu
                label={messages(STATES[state])}
                active={state !== "open"}
                accessibilityLabel={gt("Filter by state")}
                actions={choices(STATES, state, messages)}
                onSelect={(id) => {
                  setState(id as IssueListState);
                  scrollToTop();
                }}
              />
              <ListFilterMenu
                label={messages(INVOLVEMENT[involvement])}
                active={involvement !== "all"}
                accessibilityLabel={gt("Filter by involvement")}
                actions={choices(INVOLVEMENT, involvement, messages)}
                onSelect={(id) => {
                  setInvolvement(id as IssueInvolvement);
                  scrollToTop();
                }}
              />
              <Chip
                label={
                  labels.length === 0
                    ? gt("Labels")
                    : labels.length === 1
                      ? labels[0]!
                      : gt("Labels {count}", { count: labels.length })
                }
                selected={labels.length > 0}
                trailingIcon="chevron.down"
                glass
                colorScheme={themeAppearance}
                accessibilityLabel={gt("Filter by label")}
                onPress={() =>
                  navigation.navigate("IssueFilterSearch", { kind: "labels", scopes: filterScopes })
                }
              />
              <Chip
                label={assignee === null ? gt("Assignee") : (assignee.name ?? assignee.login)}
                selected={assignee !== null}
                trailingIcon="chevron.down"
                glass
                colorScheme={themeAppearance}
                accessibilityLabel={gt("Filter by assignee")}
                onPress={() =>
                  navigation.navigate("IssueFilterSearch", {
                    kind: "assignee",
                    scopes: filterScopes,
                  })
                }
              />
              <ListFilterMenu
                label={messages(SORTS[sort])}
                active={sort !== "updated"}
                accessibilityLabel={gt("Sort issues")}
                actions={choices(SORTS, sort, messages)}
                onSelect={(id) => {
                  setSort(id as IssueListSort);
                  scrollToTop();
                }}
              />
            </ScrollView>
            {notices.map((notice) => (
              <Text key={notice} selectable className="px-4 py-1.5 text-sm text-foreground-muted">
                {notice}
              </Text>
            ))}
          </>
        }
        ListFooterComponent={
          loadingMore ? (
            <View className="items-center py-5">
              <AppActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel={gt("Loading more issues")}
              />
            </View>
          ) : moreFailure ? (
            <View className="items-center gap-2 px-8 py-4">
              <Text className="text-xs text-foreground-muted">{moreFailure}</Text>
              <Button
                label={gt("Try again")}
                accessibilityLabel={gt("Retry loading more issues")}
                onPress={() => void loadMore(true)}
              />
            </View>
          ) : continuable.length > 0 ? (
            // A filtered page can be too short to scroll, which leaves nothing to reach the end of.
            <View className="items-center py-4">
              <Button
                label={gt("Load more")}
                accessibilityLabel={gt("Load more issues")}
                onPress={() => void loadMore()}
              />
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          list.isPending && list.answers.length === 0 ? (
            <View className="items-center py-12">
              <AppActivityIndicator colorClassName="accent-icon" />
            </View>
          ) : (
            <View className="px-8 py-12">
              <EmptyState
                title={
                  list.error
                    ? gt("Couldn't load issues")
                    : connected.length > 0
                      ? query
                        ? gt("No results")
                        : gt("No matching issues")
                      : capable.length > 0
                        ? gt("Environment offline")
                        : environments.length > 0
                          ? gt("Issues unavailable")
                          : gt("Connect an environment")
                }
                detail={
                  list.error ??
                  (connected.length > 0
                    ? gt("Issues from your environments' projects appear here.")
                    : capable.length > 0
                      ? gt("Reconnect to load issues.")
                      : environments.length > 0
                        ? gt("Update the environment's T3 Code server to browse issues.")
                        : gt("Add an environment in Settings to browse its issues."))
                }
                variant="plain"
              />
            </View>
          )
        }
      />
    </View>
  );
  return props.renderFrame ? props.renderFrame(headerMenu, content) : content;
}
