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
  type NativeStackHeaderItemMenu,
  type NativeStackNavigationEventMap,
  type NativeStackNavigationOptions,
  type NativeStackNavigatorProps,
  type NativeStackTypeBag,
} from "@react-navigation/native-stack";
import { use, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { View } from "react-native";
import { Split, type SplitHostCommands } from "react-native-screens";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { WorkspaceTabsProvider } from "../workspace/WorkspaceTabsContext";
import { WorkspaceNativeTabs } from "../workspace/WorkspaceNativeTabs.ios";
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
  collapsedSplitTransition,
  nativeWorkspacePopAction,
  projectWorkspaceStack,
  partitionStackPresentations,
  type CollapsedSplitColumn,
} from "../../native/workspace-stack-projection";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceInspectorContext,
  NativeWorkspaceModeContext,
} from "../../native/v5-workspace-context";

type ViewProps = ComponentProps<typeof NativeStackView>;
type Descriptor = ViewProps["descriptors"][string];
type Route = ViewProps["state"]["routes"][number];

function ColumnScreen(props: {
  readonly descriptor: Descriptor;
  readonly primary?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly selectedPullRequestKey?: string | null;
  readonly sidebarFilter?: NativeStackHeaderItemMenu;
  readonly onDismiss: (routeKey: string) => void;
  readonly onAppearance: (type: "willAppear" | "didAppear" | "willDisappear", key: string) => void;
  readonly navigation: ViewProps["navigation"];
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
      onDismiss={(event) => {
        if (event.nativeEvent.isNativeDismiss) props.onDismiss(key);
      }}
      onWillAppear={() => {
        props.onAppearance("willAppear", key);
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: false } });
      }}
      onDidAppear={() => {
        props.onAppearance("didAppear", key);
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: false } });
      }}
      onWillDisappear={() => {
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
            options={descriptor.options}
            canGoBack={!props.primary}
            primary={props.primary}
            sidebarFilter={props.sidebarFilter}
          />
          <ColumnContent
            primary={props.primary}
            insetHorizontally={
              (descriptor.options as AppNativeStackNavigationOptions).nativeContentInsetHorizontally
            }
          >
            <NativePrimaryColumnContext value={primaryColumn}>
              {descriptor.render()}
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
  const { layout, panes, togglePrimarySidebar, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const inspector = use(NativeWorkspaceInspectorContext);
  const hostRef = useRef<SplitHostCommands>(null);
  const activeDetailKey = props.detail.at(-1)?.key;
  const compactColumn = activeDetailKey ? "secondary" : "primary";
  const collapsed = useRef(!layout.usesSplitView);
  const collapsedColumn = useRef<CollapsedSplitColumn>({ visible: compactColumn, leaving: null });
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
    if (transition.pop) props.navigation.dispatch(transition.pop);
  };

  useEffect(() => {
    if (layout.usesSplitView || collapsedColumn.current.visible === compactColumn) return;
    collapsedColumn.current = { ...collapsedColumn.current, visible: compactColumn };
    hostRef.current?.show(compactColumn);
  }, [compactColumn, layout.usesSplitView]);

  const primary = props.descriptors[props.primary.key];
  if (!primary) return null;
  const sidebarFilter = (primary.options as AppNativeStackNavigationOptions).nativeSidebarFilter;
  return (
    <Split.Host
      ref={hostRef}
      testID="adaptive-workspace-layout"
      preferredSplitBehavior="tile"
      topColumnForCollapsing={compactColumn}
      onCollapse={() => {
        collapsed.current = true;
        collapsedColumn.current = { visible: compactColumn, leaving: null };
      }}
      onExpand={() => {
        collapsed.current = false;
      }}
      preferredDisplayMode={
        panes.primarySidebarVisible || (!layout.usesSplitView && !activeDetailKey)
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
              sidebarFilter={sidebarFilter}
            />
            <ColumnContent>
              <WorkspaceEmptyDetail
                onStartNewTask={() =>
                  props.navigation.navigate("NewTaskSheet", { screen: "NewTask" })
                }
              />
            </ColumnContent>
          </Split.Screen>
          {props.detail.map((route) => {
            const descriptor = props.descriptors[route.key];
            return descriptor ? (
              <ColumnScreen
                key={route.key}
                descriptor={descriptor}
                onDismiss={handleNativeDismiss}
                onAppearance={followCollapsedSplit}
                navigation={props.navigation}
                sidebarFilter={sidebarFilter}
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
