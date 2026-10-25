import {
  createNavigatorFactory,
  NavigationContext,
  NavigationRouteContext,
  StackRouter,
  useNavigationBuilder,
  type NavigatorTypeBagBase,
  type ParamListBase,
  type StackActionHelpers,
  type StackNavigationState,
  type StackRouterOptions,
  type StaticConfig,
  type TypedNavigator,
} from "@react-navigation/native";
import {
  NativeStackView,
  type NativeStackNavigationEventMap,
  type NativeStackNavigationOptions,
  type NativeStackNavigatorProps,
  type NativeStackTypeBag,
} from "@react-navigation/native-stack";
import {
  Fragment,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { View } from "react-native";
import { Split, type SplitHostCommands } from "react-native-screens";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { WorkspaceNativeTabs } from "../workspace/WorkspaceNativeTabs.ios";
import { workspaceUsesColumns } from "../workspace/workspace-tabs-state";
import { isSettingsRoute, settingsOpenIn } from "../settings/settings-navigation";
import { workspaceRoutesOf } from "./workspace-overlay-routes";
import { setNativelyPoppingWorkspaceRoute } from "../workspace/workspace-detail-selection";
import { useDeviceType, useNativeLayoutMetrics } from "../../native/native-layout-metrics";

import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "./WorkspaceEmptyDetail";
import { NativeColumnContent as ColumnContent } from "../../native/NativeColumnContent.ios";
import {
  modalEnvelopeOptions,
  V5CardStackView,
  V5StackView,
} from "../../native/createV5StackNavigator.ios";
import {
  useNativeWorkspaceColumnsReady,
  useNativeWorkspaceColumnsSupported,
} from "../../native/NativeWorkspaceColumns";
import { V5StackHeader } from "../../native/V5StackHeader.ios";
import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import {
  collapsedSplitTransition,
  nativeWorkspacePopAction,
  projectWorkspaceStack,
  partitionStackPresentations,
  reconcileStackScreens,
  type CollapsedSplitColumn,
} from "../../native/workspace-stack-projection";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceInspectorContext,
  NativeWorkspaceModeContext,
  WorkspaceSlotOptionsContext,
  slotScreenOptions,
} from "../../native/v5-workspace-context";

type ViewProps = ComponentProps<typeof NativeStackView>;
type Descriptor = ViewProps["descriptors"][string];
type Route = ViewProps["state"]["routes"][number];

const isPullRequestRoute = (route: Route) =>
  route.name === "PullRequest" ||
  route.name === "PullRequestFile" ||
  route.name === "PullRequestFiles";

/** Beside the list, the first Settings page shows on one native screen that swaps its content. */
const SETTINGS_DETAIL_SCREEN = "settings-detail";

function ColumnScreen(props: {
  readonly descriptor: Descriptor;
  readonly screenKey?: string;
  readonly primary?: boolean;
  readonly attached?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly selectedPullRequestKey?: string | null;
  readonly onDismiss: (routeKey: string, native: boolean) => void;
  readonly onAppearance: (type: "willAppear" | "didAppear" | "willDisappear", key: string) => void;
  readonly onCompose?: () => void;
  readonly navigation: ViewProps["navigation"];
}) {
  const { descriptor } = props;
  // Options a screen set inside this workspace tab slot, over its route's.
  const options = slotScreenOptions(
    use(WorkspaceSlotOptionsContext),
    descriptor.route.key,
    descriptor.options,
  );
  const [presented, setPresented] = useState(false);
  const primaryColumn = useMemo(
    () =>
      props.primary
        ? {
            presented,
            selectedThreadKey: props.selectedThreadKey ?? null,
            selectedPullRequestKey: props.selectedPullRequestKey ?? null,
          }
        : null,
    [props.primary, props.selectedThreadKey, props.selectedPullRequestKey, presented],
  );
  const key = descriptor.route.key;
  return (
    <Split.Screen
      screenKey={props.screenKey ?? key}
      activityMode={props.attached === false ? "detached" : "attached"}
      onDismiss={(event) => {
        props.onDismiss(key, event.nativeEvent.isNativeDismiss);
      }}
      onWillAppear={() => {
        props.onAppearance("willAppear", key);
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: false } });
      }}
      onDidAppear={() => {
        setPresented(true);
        props.onAppearance("didAppear", key);
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: false } });
      }}
      onWillDisappear={() => {
        setPresented(false);
        props.onAppearance("willDisappear", key);
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: true } });
      }}
      onDidDisappear={() =>
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: true } })
      }
    >
      <NavigationContext value={descriptor.navigation}>
        <NavigationRouteContext value={descriptor.route}>
          <V5StackHeader
            options={options}
            canGoBack={!props.primary}
            column={props.primary ? "primary" : "detail"}
            onCompose={
              descriptor.route.params &&
              "draft" in descriptor.route.params &&
              descriptor.route.params.draft
                ? undefined
                : props.onCompose
            }
          />
          <ColumnContent
            primary={props.primary}
            insetHorizontally={
              (options as AppNativeStackNavigationOptions).nativeContentInsetHorizontally
            }
          >
            <NativePrimaryColumnContext value={primaryColumn}>
              {/* The Settings slot swaps pages here; its column keeps its measured insets. */}
              <Fragment key={key}>{descriptor.render()}</Fragment>
            </NativePrimaryColumnContext>
          </ColumnContent>
        </NavigationRouteContext>
      </NavigationContext>
    </Split.Screen>
  );
}

function WorkspaceColumns(
  props: ViewProps & { readonly primary: Route; readonly detail: Route[] },
) {
  const {
    layout,
    panes,
    togglePrimarySidebar,
    setPrimarySidebarVisible,
    toggleAuxiliaryPane,
    startNewTask,
    openWorkspaceTab,
    sidebarByOrientation,
  } = useAdaptiveWorkspaceLayout();
  const deviceType = useDeviceType();
  const settingsDetailIn = (detail: readonly Route[]) =>
    layout.usesSplitView && detail[0] && isSettingsRoute(detail[0].name) ? detail[0] : undefined;
  // Split screens must remain mounted while UIKit animates a detached route away.
  const [screens, setScreens] = useState({
    routes: props.detail,
    descriptors: props.descriptors,
    observedRoutes: props.detail,
    observedDescriptors: props.descriptors,
    completed: new Set<string>(),
  });
  if (
    screens.observedRoutes !== props.detail ||
    screens.observedDescriptors !== props.descriptors
  ) {
    const active = new Set(props.detail.map((route) => route.key));
    const settingsSlot = settingsDetailIn(props.detail);
    const routes = reconcileStackScreens(screens.routes, props.detail, screens.completed).filter(
      // The slot's native screen stays; the pages it showed, and any above them, just go.
      (route) => !settingsSlot || active.has(route.key) || !isSettingsRoute(route.name),
    );
    const retained = new Set(routes.map((route) => route.key));
    setScreens({
      routes,
      descriptors: Object.fromEntries(
        Object.entries({ ...screens.descriptors, ...props.descriptors }).filter(([key]) =>
          retained.has(key),
        ),
      ),
      observedRoutes: props.detail,
      observedDescriptors: props.descriptors,
      completed: new Set([...screens.completed].filter((key) => active.has(key))),
    });
  }

  const workspaceTabs = useWorkspaceTabs();
  const selectedTab = workspaceTabs?.state.selectedTab;
  const settingsOpen = workspaceTabs?.settingsOpen ?? false;
  const openNewTask = startNewTask;
  // The cover detail rail needs room for thread tools above the fixed tabs.
  // The unfolded Duo keeps compose in its detail bar.
  const detailCompose =
    deviceType === "duo-unfolded" && selectedTab !== "pullRequests" && !settingsOpen
      ? openNewTask
      : undefined;
  const inspector = use(NativeWorkspaceInspectorContext);
  const hostRef = useRef<SplitHostCommands>(null);
  const activeDetailKey = props.detail.at(-1)?.key;
  const compactColumn = activeDetailKey ? "secondary" : "primary";
  const collapsed = useRef(!layout.usesSplitView);
  const collapsedColumn = useRef<CollapsedSplitColumn>({ visible: compactColumn, leaving: null });
  const threadParams = props.detail.findLast((route) => route.name === "Thread")?.params;
  const pullRequestParams = props.detail.findLast(isPullRequestRoute)?.params;
  const selectedPullRequestKey =
    pullRequestParams &&
    "environmentId" in pullRequestParams &&
    "host" in pullRequestParams &&
    "repository" in pullRequestParams &&
    "number" in pullRequestParams &&
    typeof pullRequestParams.environmentId === "string" &&
    typeof pullRequestParams.host === "string" &&
    typeof pullRequestParams.repository === "string" &&
    typeof pullRequestParams.number === "number"
      ? `${pullRequestParams.environmentId}:${pullRequestParams.host}:${pullRequestParams.repository}:${pullRequestParams.number}`
      : null;
  const selectedThreadKey =
    threadParams &&
    "environmentId" in threadParams &&
    "threadId" in threadParams &&
    typeof threadParams.environmentId === "string" &&
    typeof threadParams.threadId === "string"
      ? scopedThreadKey(
          EnvironmentId.make(threadParams.environmentId),
          ThreadId.make(threadParams.threadId),
        )
      : null;
  const handleNativeDismiss = useCallback(
    (key: string, native: boolean) => {
      setScreens((current) => ({
        ...current,
        routes: current.routes.filter((route) => route.key !== key),
        completed: new Set([...current.completed, key]),
      }));
      if (native) {
        const state = props.navigation.getState();
        const action = nativeWorkspacePopAction(state, key);
        if (action) props.navigation.dispatch(action);
      }
    },
    [props.navigation],
  );
  const followCollapsedSplit = (
    type: "willAppear" | "didAppear" | "willDisappear",
    key: string,
  ) => {
    if (!collapsed.current || layout.usesSplitView) return;
    const transition = collapsedSplitTransition(
      collapsedColumn.current,
      { type, key },
      props.navigation.getState(),
      props.primary.key,
    );
    collapsedColumn.current = transition.column;
    setNativelyPoppingWorkspaceRoute(transition.column.leaving);
    if (transition.pop) props.navigation.dispatch(transition.pop);
  };

  useEffect(() => {
    if (layout.usesSplitView || collapsedColumn.current.visible === compactColumn) return;
    collapsedColumn.current = { ...collapsedColumn.current, visible: compactColumn };
    hostRef.current?.show(compactColumn);
  }, [compactColumn, layout.usesSplitView]);

  const primary = props.descriptors[props.primary.key];
  if (!primary) return null;
  return (
    <Split.Host
      ref={hostRef}
      testID="adaptive-workspace-layout"
      preferredSplitBehavior={
        !sidebarByOrientation && layout.primarySidebarOverlaysContent ? "overlay" : "tile"
      }
      portraitPreferredSplitBehavior={sidebarByOrientation ? "overlay" : undefined}
      portraitPreferredDisplayMode={
        sidebarByOrientation ? sidebarDisplayMode(sidebarByOrientation.portrait, true) : undefined
      }
      primaryBackgroundStyle={deviceType === "pad" ? "none" : "default"}
      topColumnForCollapsing={compactColumn}
      onCollapse={() => {
        collapsed.current = true;
        collapsedColumn.current = { visible: compactColumn, leaving: null };
        setNativelyPoppingWorkspaceRoute(null);
      }}
      onExpand={() => {
        collapsed.current = false;
        setNativelyPoppingWorkspaceRoute(null);
        // Native callbacks can outlive the render that created them, so decide from the live
        // router state. An expanded split has columns, so its tab gets a page beside the list.
        const live = props.navigation.getState();
        const { workspace } = workspaceRoutesOf(live.routes.slice(0, live.index + 1));
        if (workspace.some((route) => route.name !== "Home" && route.name !== "Settings")) return;
        const tab = workspace.some((route) => route.name === "Settings")
          ? "settings"
          : (["threads", "pullRequests", "usage"] as const).find((candidate) =>
              workspaceTabs?.isTabActive(candidate),
            );
        openWorkspaceTab(tab ?? "threads", { columns: true });
      }}
      preferredDisplayMode={
        sidebarByOrientation
          ? sidebarDisplayMode(sidebarByOrientation.landscape, false)
          : sidebarDisplayMode(
              // UIKit applies the mode as a collapsed split expands, before the new width reaches
              // JS, so a collapsed split already carries the sidebar the expanded one will show.
              (layout.usesSplitView
                ? panes.primarySidebarVisible
                : panes.primarySidebarWhenExpanded) ||
                (!layout.usesSplitView && !activeDetailKey),
              layout.primarySidebarOverlaysContent,
            )
      }
      onDisplayModeWillChange={({ nativeEvent }) => {
        if (!layout.primarySidebarOverlaysContent) return;
        if (nativeEvent.nextDisplayMode === "oneOverSecondary") setPrimarySidebarVisible(true);
        else if (nativeEvent.nextDisplayMode === "secondaryOnly") setPrimarySidebarVisible(false);
      }}
      displayModeButtonVisibility="never"
      presentsWithGesture
      showInspector={inspector.visible}
      onInspectorHide={() => {
        if (inspector.visible) toggleAuxiliaryPane();
      }}
      columnMetrics={{
        minimumPrimaryColumnWidth: 280,
        maximumPrimaryColumnWidth: Math.max(380, layout.listPaneWidth ?? 0),
        preferredPrimaryColumnWidthOrFraction: layout.listPaneWidth ?? 320,
        minimumSecondaryColumnWidth: 320,
      }}
    >
      <Split.Column>
        <Split.Stack>
          <ColumnScreen
            descriptor={primary}
            primary
            selectedThreadKey={selectedThreadKey}
            selectedPullRequestKey={selectedPullRequestKey}
            onDismiss={handleNativeDismiss}
            onAppearance={followCollapsedSplit}
            navigation={props.navigation}
          />
        </Split.Stack>
      </Split.Column>
      <Split.Column>
        <Split.Stack>
          <Split.Screen
            screenKey="workspace-empty"
            activityMode={layout.usesSplitView && !activeDetailKey ? "attached" : "detached"}
          >
            <V5StackHeader
              options={{
                headerShown: true,
                title: "",
                unstable_headerLeftItems: () => [
                  {
                    type: "button",
                    label: "",
                    icon: { type: "sfSymbol", name: "sidebar.left" },
                    onPress: togglePrimarySidebar,
                  },
                ],
              }}
              canGoBack={false}
              column="detail"
              onCompose={detailCompose}
            />
            <ColumnContent>
              <WorkspaceEmptyDetail
                tab={settingsOpen ? "settings" : selectedTab}
                onStartNewTask={
                  // Duo provides compose in the detail bar; iPad uses the empty-state action.
                  detailCompose ? undefined : openNewTask
                }
              />
            </ColumnContent>
          </Split.Screen>
          {screens.routes.map((route) => {
            const descriptor = props.descriptors[route.key] ?? screens.descriptors[route.key];
            const inSettingsSlot = settingsDetailIn(props.detail)?.key === route.key;
            const screenKey = inSettingsSlot ? SETTINGS_DETAIL_SCREEN : route.key;
            return descriptor ? (
              <ColumnScreen
                key={screenKey}
                screenKey={screenKey}
                descriptor={descriptor}
                attached={props.detail.some((current) => current.key === route.key)}
                onDismiss={handleNativeDismiss}
                onAppearance={followCollapsedSplit}
                onCompose={isPullRequestRoute(route) ? undefined : detailCompose}
                navigation={props.navigation}
              />
            ) : null;
          })}
        </Split.Stack>
      </Split.Column>
      <Split.Inspector>
        <Split.HeaderConfig hidden />
        {/* Inspector panes host their own native stacks, which UIKit insets for the Duo's
            vertical bar wherever they sit, so each pane insets its own content instead. */}
        <ColumnContent insetHorizontally={false}>
          <View className="flex-1 bg-screen">{inspector.render?.()}</View>
        </ColumnContent>
      </Split.Inspector>
    </Split.Host>
  );
}

function WorkspaceStackView(props: ViewProps & { readonly nativeColumns: boolean }) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  // Native dismiss commits the route pop after the transition. Restore the dock
  // when the primary screen starts appearing, including interactive back gestures.
  const [primaryVisible, setPrimaryVisible] = useState(false);
  const metrics = useNativeLayoutMetrics();
  const projection = projectWorkspaceStack(props.state, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return presentation !== undefined && presentation !== "card";
  });
  // Detail-only histories must stay single-stack: placeholder descriptors cannot own sidebar actions or setOptions.
  const primaryRoute = projection.primary;
  if (!primaryRoute) return <V5StackView {...props} />;
  const primaryDescriptor = props.descriptors[primaryRoute.key]!;
  const descriptors = props.descriptors;
  const baseRoute = { key: `${props.state.key}:workspace`, name: "Workspace" };
  const visibleRoute = projection.detail.at(-1) ?? primaryRoute;
  const workspacePage = !workspaceUsesColumns(workspace.state.selectedTab, workspace.settingsOpen);
  const baseDescriptor: Descriptor = {
    ...primaryDescriptor,
    navigation: props.descriptors[visibleRoute.key]!.navigation,
    // Identify the real visible route under the stable envelope key, or useIsFocused closes media viewers.
    route: visibleRoute,
    options: { headerShown: false },
    render: () => (
      <WorkspaceNativeTabs
        hidden={
          !workspacePage &&
          projection.detail.length > 0 &&
          !primaryVisible &&
          !layout.usesSplitView &&
          (metrics?.verticalBarEdge ?? "none") === "none"
        }
      >
        {props.nativeColumns && !workspacePage ? (
          <WorkspaceColumns
            {...props}
            descriptors={descriptors}
            primary={primaryRoute}
            detail={projection.detail}
          />
        ) : (
          <V5CardStackView
            {...props}
            onRootVisibilityChange={setPrimaryVisible}
            onNativePopChange={setNativelyPoppingWorkspaceRoute}
            descriptors={descriptors}
            state={{
              ...props.state,
              routes: [primaryRoute, ...projection.detail],
              index: projection.detail.length,
              preloadedRoutes: [],
            }}
          />
        )}
      </WorkspaceNativeTabs>
    ),
  };
  const overlays = partitionStackPresentations(projection.overlays, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return presentation !== undefined && presentation !== "card";
  });
  const routes = [baseRoute, ...overlays.map((group) => group[0]!)];
  return (
    <NativeStackView
      presentationEnvelope
      {...props}
      state={{ ...props.state, routes, index: routes.length - 1, preloadedRoutes: [] }}
      descriptors={{
        ...Object.fromEntries(
          overlays.map((group) => {
            const route = group[0]!;
            const descriptor = props.descriptors[route.key]!;
            const visibleRoute = group.at(-1)!;
            return [
              route.key,
              {
                ...descriptor,
                navigation: props.descriptors[visibleRoute.key]!.navigation,
                route: visibleRoute,
                options: modalEnvelopeOptions(descriptor.options),
                render: () => (
                  <V5CardStackView
                    {...props}
                    state={{
                      ...props.state,
                      routes: group,
                      index: group.length - 1,
                      preloadedRoutes: [],
                    }}
                  />
                ),
              },
            ];
          }),
        ),
        [baseRoute.key]: baseDescriptor,
      }}
    />
  );
}

function WorkspaceStackNavigator({
  id,
  initialRouteName,
  UNSTABLE_routeNamesChangeBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
  ...rest
}: NativeStackNavigatorProps) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const nativeWorkspaceColumnsReady = useNativeWorkspaceColumnsReady();
  const { state, describe, descriptors, navigation, NavigationContent } = useNavigationBuilder<
    StackNavigationState<ParamListBase>,
    StackRouterOptions,
    StackActionHelpers<ParamListBase>,
    NativeStackNavigationOptions,
    NativeStackNavigationEventMap
  >(StackRouter, {
    id,
    initialRouteName,
    UNSTABLE_routeNamesChangeBehavior,
    children,
    layout,
    screenListeners,
    screenOptions,
    screenLayout,
    UNSTABLE_router,
  });
  if (!nativeWorkspaceColumnsReady) return null;
  const settingsOpen = settingsOpenIn(
    state.routes.slice(0, state.index + 1).filter((route) => {
      const presentation = descriptors[route.key]?.options.presentation;
      return presentation === undefined || presentation === "card";
    }),
  );
  return (
    <NativeWorkspaceModeContext value={usesNativeWorkspaceColumns}>
      <NavigationContent>
        <WorkspaceTabsProvider settingsOpen={settingsOpen}>
          <WorkspaceStackView
            nativeColumns={usesNativeWorkspaceColumns}
            {...rest}
            state={state}
            describe={describe}
            descriptors={descriptors}
            navigation={navigation}
          />
        </WorkspaceTabsProvider>
      </NavigationContent>
    </NativeWorkspaceModeContext>
  );
}

type WorkspaceTypeBag<
  ParamList extends ParamListBase,
  NavigatorID extends string | undefined,
> = Omit<NativeStackTypeBag<ParamList, NavigatorID>, "Navigator"> & {
  Navigator: typeof WorkspaceStackNavigator;
};

export function createWorkspaceStackNavigator<
  const ParamList extends ParamListBase,
  const NavigatorID extends string | undefined = string | undefined,
  const TypeBag extends NavigatorTypeBagBase = WorkspaceTypeBag<ParamList, NavigatorID>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(WorkspaceStackNavigator)(config);
}

function sidebarDisplayMode(visible: boolean, overlay: boolean) {
  if (!visible) return "secondaryOnly";
  return overlay ? "oneOverSecondary" : "oneBesideSecondary";
}
