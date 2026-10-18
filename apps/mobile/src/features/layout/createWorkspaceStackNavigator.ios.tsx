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
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Split, type SplitHostCommands } from "react-native-screens";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { WorkspaceTabsProvider } from "../workspace/WorkspaceTabsContext";
import { WorkspaceNativeTabs } from "../workspace/WorkspaceNativeTabs.ios";
import { SettingsScopeProvider } from "../settings/settings-environment-filter";
import type { SettingsSearchItem } from "../settings/settings-search";
import {
  resolveSettingsLocation,
  settingsSectionState,
  settingsSheetStateFor,
} from "../settings/settings-sections";
import { SettingsSidebarColumn } from "../settings/SettingsSidebar.ios";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";

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
  nativeWorkspacePopAction,
  projectWorkspaceStack,
  partitionStackPresentations,
  replaceWorkspaceRouteAction,
} from "../../native/workspace-stack-projection";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceInspectorContext,
  NativeWorkspaceModeContext,
} from "../../native/v5-workspace-context";

type ViewProps = ComponentProps<typeof NativeStackView>;
type Descriptor = ViewProps["descriptors"][string];
type Route = ViewProps["state"]["routes"][number];

// Matches the split's native primary column resize, so content kept off the
// fold moves with the column edge.
const COLUMN_RESIZE_TIMING = {
  duration: 300,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

const SETTINGS_PAGE_ID = "workspace-settings-page";

// A book fold ends the sidebar, leaving the crease at the start of the detail
// column, inside its safe area. Taking the gap from the layout that sizes the
// sidebar keeps both in one commit; the column's own metrics would first report
// the fold mid-column, before the sidebar widens to it. A window resize moves
// the columns at once, so the gap does too.
function FoldAvoidingView(props: { readonly nativeID: string; readonly children: ReactNode }) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const width = useNativeLayoutMetrics()?.width;
  const gap = layout.usesSplitView ? (layout.listPaneGap ?? 0) : 0;
  const margin = useSharedValue(gap);
  const settledWidth = useRef(width);
  useEffect(() => {
    const resized = settledWidth.current !== width;
    settledWidth.current = width;
    margin.set(resized ? gap : withTiming(gap, COLUMN_RESIZE_TIMING));
  }, [gap, margin, width]);
  const style = useAnimatedStyle(() => ({ marginLeft: margin.get() }));
  return (
    <Animated.View nativeID={props.nativeID} style={[{ flex: 1 }, style]}>
      {props.children}
    </Animated.View>
  );
}

function ColumnScreen(props: {
  readonly descriptor: Descriptor;
  readonly primary?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly selectedPullRequestKey?: string | null;
  readonly onDismiss: (routeKey: string) => void;
  readonly navigation: ViewProps["navigation"];
  readonly activityMode?: ComponentProps<typeof Split.Screen>["activityMode"];
  /** Keeps the content clear of a book fold, as the view with this nativeID. */
  readonly foldAvoidingID?: string;
  readonly onDidAppear?: () => void;
  /** Replaces the route's header and content without pushing another screen. */
  readonly cover?: ReactNode;
}) {
  const { descriptor } = props;
  const primaryColumn = useMemo(
    () =>
      props.primary
        ? {
            selectedThreadKey: props.selectedThreadKey ?? null,
            selectedPullRequestKey: props.selectedPullRequestKey ?? null,
          }
        : null,
    [props.primary, props.selectedThreadKey, props.selectedPullRequestKey],
  );
  const key = descriptor.route.key;
  return (
    <Split.Screen
      screenKey={key}
      activityMode={props.activityMode}
      onDismiss={(event) => {
        if (event.nativeEvent.isNativeDismiss) props.onDismiss(key);
      }}
      onWillAppear={() =>
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: false } })
      }
      onDidAppear={() => {
        props.onDidAppear?.();
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: false } });
      }}
      onWillDisappear={() =>
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: true } })
      }
      onDidDisappear={() =>
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: true } })
      }
    >
      {props.cover ?? (
        <NavigationContext value={descriptor.navigation}>
          <NavigationRouteContext value={descriptor.route}>
            <V5StackHeader
              options={descriptor.options}
              canGoBack={!props.primary}
              primary={props.primary}
            />
            <ColumnContent
              primary={props.primary}
              insetHorizontally={
                (descriptor.options as AppNativeStackNavigationOptions)
                  .nativeContentInsetHorizontally
              }
            >
              <NativePrimaryColumnContext value={primaryColumn}>
                {props.foldAvoidingID ? (
                  <FoldAvoidingView nativeID={props.foldAvoidingID}>
                    {descriptor.render()}
                  </FoldAvoidingView>
                ) : (
                  descriptor.render()
                )}
              </NativePrimaryColumnContext>
            </ColumnContent>
          </NavigationRouteContext>
        </NavigationContext>
      )}
    </Split.Screen>
  );
}

function WorkspaceColumns(
  props: ViewProps & { readonly primary: Route; readonly detail: Route[] },
) {
  const { layout, panes, togglePrimarySidebar, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  // The split resizes its sidebar gradually, so a collapsed split keeps the
  // width it will expand to instead of resizing as it unfolds.
  const [primaryWidth, setPrimaryWidth] = useState(layout.listPaneWidth ?? 320);
  if (layout.listPaneWidth !== null && layout.listPaneWidth !== primaryWidth) {
    setPrimaryWidth(layout.listPaneWidth);
  }
  const inspector = use(NativeWorkspaceInspectorContext);
  const hostRef = useRef<SplitHostCommands>(null);
  const activeDetailKey = props.detail.at(-1)?.key;
  // Settings moves to a sheet when the split collapses, so the collapsed split
  // opens on the sidebar instead of showing settings until it leaves.
  const compactColumn =
    activeDetailKey && props.detail.at(-1)?.name !== "SettingsSheet" ? "secondary" : "primary";
  const shownCompactColumn = useRef(compactColumn);
  const threadParams = props.detail.findLast((route) => route.name === "Thread")?.params;
  const pullRequestParams = props.detail.findLast(
    (route) =>
      route.name === "PullRequest" ||
      route.name === "PullRequestFile" ||
      route.name === "PullRequestFiles",
  )?.params;
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
    (key: string) => {
      const state = props.navigation.getState();
      const action = nativeWorkspacePopAction(state, key);
      if (action) props.navigation.dispatch(action);
    },
    [props.navigation],
  );
  const settingsIndex = props.detail.findLastIndex((route) => route.name === "SettingsSheet");
  const settingsRoute = props.detail[settingsIndex];
  const settingsDescriptor = settingsRoute ? props.descriptors[settingsRoute.key] : undefined;
  const closeSettings = useCallback(() => {
    const state = props.navigation.getState();
    const route = state.routes.findLast((candidate) => candidate.name === "SettingsSheet");
    const action = route ? nativeWorkspacePopAction(state, route.key) : null;
    if (action) props.navigation.dispatch(action);
  }, [props.navigation]);
  const selectSettingsPage = useCallback(
    (page: SettingsSearchItem["page"]) => {
      const state = props.navigation.getState();
      const index = state.routes.findLastIndex((candidate) => candidate.name === "SettingsSheet");
      const route = state.routes[index];
      if (!route) return;
      const location = resolveSettingsLocation(route);
      if (
        index === state.routes.length - 1 &&
        location.atSectionRoot &&
        location.section === page
      ) {
        return;
      }
      // Replacing the whole sheet keeps each section a root page, so its content
      // swaps in place instead of pushing onto the previous section.
      const action = replaceWorkspaceRouteAction(state, route.key, {
        key: route.key,
        name: "SettingsSheet",
        state: settingsSectionState(page),
      });
      if (action) props.navigation.dispatch(action);
    },
    [props.navigation],
  );

  // A collapsed split's Back reveals the sidebar without a router change. The
  // sidebar's appearance records it, so the next detail is brought forward.
  useEffect(() => {
    if (layout.usesSplitView) {
      shownCompactColumn.current = compactColumn;
      return;
    }
    if (shownCompactColumn.current === compactColumn) return;
    shownCompactColumn.current = compactColumn;
    hostRef.current?.show(compactColumn);
  }, [compactColumn, layout.usesSplitView]);

  const primary = props.descriptors[props.primary.key];
  if (!primary) return null;
  return (
    <Split.Host
      ref={hostRef}
      testID="adaptive-workspace-layout"
      preferredSplitBehavior="tile"
      // The sidebar style extends the detail column beneath the sidebar and
      // insets its content through the safe area, which reaches React a frame
      // late. Tiled columns resize their content in the frame the sidebar
      // resizes, so the two never part while the sidebar follows the fold.
      primaryBackgroundStyle="none"
      topColumnForCollapsing={compactColumn}
      preferredDisplayMode={
        panes.primarySidebarVisible ||
        settingsDescriptor ||
        (!layout.usesSplitView && !activeDetailKey)
          ? "oneBesideSecondary"
          : "secondaryOnly"
      }
      displayModeButtonVisibility="never"
      presentsWithGesture
      showInspector={inspector.visible}
      onInspectorHide={() => {
        if (inspector.visible) toggleAuxiliaryPane();
      }}
      columnMetrics={{
        minimumPrimaryColumnWidth: 280,
        maximumPrimaryColumnWidth: Math.max(380, primaryWidth),
        preferredPrimaryColumnWidthOrFraction: primaryWidth,
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
            onDidAppear={() => {
              if (!layout.usesSplitView) shownCompactColumn.current = "primary";
            }}
            navigation={props.navigation}
            // A second screen here would be popped when settings closes. Folding the
            // Duo nests the detail column above this stack first, so that pop would
            // no longer be the top screen and RNScreens aborts.
            cover={
              settingsRoute && settingsDescriptor ? (
                <NavigationContext value={settingsDescriptor.navigation}>
                  <NavigationRouteContext value={settingsDescriptor.route}>
                    <SettingsSidebarColumn
                      selectedSection={resolveSettingsLocation(settingsRoute).section}
                      onSelect={selectSettingsPage}
                      onClose={closeSettings}
                    />
                  </NavigationRouteContext>
                </NavigationContext>
              ) : undefined
            }
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
            />
            <ColumnContent>
              <WorkspaceEmptyDetail
                onStartNewTask={() =>
                  props.navigation.navigate("NewTaskSheet", { screen: "NewTask" })
                }
              />
            </ColumnContent>
          </Split.Screen>
          {props.detail.map((route, index) => {
            const descriptor = props.descriptors[route.key];
            return descriptor ? (
              <ColumnScreen
                key={route.key}
                descriptor={descriptor}
                onDismiss={handleNativeDismiss}
                navigation={props.navigation}
                // Settings owns the detail column alone, so no Back gesture uncovers
                // the thread beneath it.
                activityMode={index < settingsIndex ? "detached" : "attached"}
                foldAvoidingID={index === settingsIndex ? SETTINGS_PAGE_ID : undefined}
              />
            ) : null;
          })}
        </Split.Stack>
      </Split.Column>
      <Split.Inspector>
        <Split.HeaderConfig hidden />
        <ColumnContent>
          <View className="flex-1 bg-screen">{inspector.render?.()}</View>
        </ColumnContent>
      </Split.Inspector>
    </Split.Host>
  );
}

function WorkspaceStackView(props: ViewProps & { readonly nativeColumns: boolean }) {
  const { layout } = useAdaptiveWorkspaceLayout();
  // Native dismiss commits the route pop after the transition. Restore the dock
  // when the primary screen starts appearing, including interactive back gestures.
  const [primaryVisible, setPrimaryVisible] = useState(false);
  const metrics = useNativeLayoutMetrics();
  const projection = projectWorkspaceStack(props.state, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return presentation !== undefined && presentation !== "card";
  });
  const overlays = partitionStackPresentations(projection.overlays, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return presentation !== undefined && presentation !== "card";
  });
  const settingsKey = props.state.routes.findLast((route) => route.name === "SettingsSheet")?.key;
  const settingsFlows =
    settingsKey !== undefined && props.descriptors[settingsKey]?.options.presentation === "card";
  const settingsInSplit = projection.detail.some((route) => route.key === settingsKey);
  // An open route keeps the presentation it opened with, but settings follows
  // the columns: its sections sit beside the sidebar, or in a sheet once the
  // split collapses. Its nested navigators remount there, and React Navigation
  // clears a navigator's state when its previous instance unmounts, so settings
  // reopens as a new route seeded with its page.
  const settingsMoving =
    props.nativeColumns && settingsKey !== undefined && settingsFlows !== layout.usesSplitView;
  // Settings that moves with the columns appears in place, and its sheet leaves
  // by moving onto the page that takes it over. Modal changes stay instant until
  // the open modals next change, because the native stack applies them after the
  // commit that carries them has mounted.
  const modalKeys = overlays.map((group) => group[0]!.key).join(" ");
  const [settingsSwap, setSettingsSwap] = useState<
    "moving" | { readonly modalKeys: string } | null
  >(null);
  if (settingsMoving) {
    if (settingsSwap !== "moving") setSettingsSwap("moving");
  } else if (settingsSwap === "moving") {
    setSettingsSwap(settingsKey === undefined ? null : { modalKeys });
  } else if (settingsSwap !== null && settingsSwap.modalKeys !== modalKeys) {
    setSettingsSwap(null);
  }
  const instantModalTransitions =
    settingsSwap !== null && settingsSwap !== "moving" && settingsSwap.modalKeys === modalKeys;
  useLayoutEffect(() => {
    if (!settingsMoving) return;
    const state = props.navigation.getState();
    const route = state.routes.find((candidate) => candidate.key === settingsKey);
    if (!route) return;
    const action = replaceWorkspaceRouteAction(state, route.key, {
      name: "SettingsSheet",
      state: settingsSheetStateFor(route, layout.usesSplitView),
    });
    if (action) props.navigation.dispatch(action);
  }, [layout.usesSplitView, props.navigation, settingsKey, settingsMoving]);
  // Linking normally restores Home via initialRouteName. A detail-only history
  // must stay a single stack: placeholder descriptors cannot own an interactive
  // sidebar because React Navigation rejects their actions and setOptions.
  const primaryRoute = projection.primary;
  if (!primaryRoute) return <V5StackView {...props} />;
  const primaryDescriptor = props.descriptors[primaryRoute.key]!;
  const descriptors = props.descriptors;
  const baseRoute = { key: `${props.state.key}:workspace`, name: "Workspace" };
  const visibleRoute = projection.detail.at(-1) ?? primaryRoute;
  const baseDescriptor: Descriptor = {
    ...primaryDescriptor,
    navigation: props.descriptors[visibleRoute.key]!.navigation,
    // The native envelope keeps a stable key, but its NavigationProvider must
    // identify the real visible route or useIsFocused closes media viewers.
    route: visibleRoute,
    options: { headerShown: false },
    render: () => (
      <WorkspaceNativeTabs
        onNewTask={() => props.navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        hidden={
          projection.detail.length > 0 &&
          !primaryVisible &&
          !layout.usesSplitView &&
          (metrics?.verticalBarEdge ?? "none") === "none"
        }
        onSelect={() => {
          if (props.state.index > 0)
            props.navigation.dispatch({ type: "POP_TO_TOP", target: props.state.key });
        }}
      >
        {props.nativeColumns ? (
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
  const routes = [baseRoute, ...overlays.map((group) => group[0]!)];
  return (
    <SettingsScopeProvider
      open={settingsKey !== undefined}
      sidebar={props.nativeColumns && settingsInSplit}
    >
      <NativeStackView
        presentationEnvelope
        {...props}
        instantModalTransitions={instantModalTransitions}
        instantModalDismissalTarget={SETTINGS_PAGE_ID}
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
    </SettingsScopeProvider>
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
  return (
    <NativeWorkspaceModeContext value={usesNativeWorkspaceColumns}>
      <NavigationContent>
        <WorkspaceTabsProvider>
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
