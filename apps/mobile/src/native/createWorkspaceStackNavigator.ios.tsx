import {
  createNavigatorFactory,
  NavigationContext,
  NavigationRouteContext,
  StackActions,
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
import { use, useCallback, useEffect, useMemo, useRef, type ComponentProps } from "react";
import { View } from "react-native";
import { Split, type SplitHostCommands } from "react-native-screens";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "../lib/scopedEntities";

import { useAdaptiveWorkspaceLayout } from "../features/layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../features/layout/WorkspaceEmptyDetail";
import { NativeColumnContent as ColumnContent } from "./NativeColumnContent.ios";
import { modalEnvelopeOptions, V5CardStackView, V5StackView } from "./createV5StackNavigator.ios";
import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "./NativeWorkspaceColumns";
import { V5StackHeader } from "./V5StackHeader.ios";
import {
  nativeWorkspacePopCount,
  projectWorkspaceStack,
  partitionStackPresentations,
} from "./workspace-stack-projection";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceInspectorContext,
  NativeWorkspaceModeContext,
} from "./v5-workspace-context";

type ViewProps = ComponentProps<typeof NativeStackView>;
type Descriptor = ViewProps["descriptors"][string];
type Route = ViewProps["state"]["routes"][number];

// These remain modal flows even when the adaptive app presents them as cards.
const MODAL_FLOWS = new Set(["SettingsSheet", "NewTaskSheet"]);

function ColumnScreen(props: {
  readonly descriptor: Descriptor;
  readonly primary?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly onDismiss: (routeKey: string) => void;
  readonly navigation: ViewProps["navigation"];
}) {
  const { descriptor } = props;
  const primaryColumn = useMemo(
    () => (props.primary ? { selectedThreadKey: props.selectedThreadKey ?? null } : null),
    [props.primary, props.selectedThreadKey],
  );
  const key = descriptor.route.key;
  return (
    <Split.Screen
      screenKey={key}
      onDismiss={(event) => {
        if (event.nativeEvent.isNativeDismiss) props.onDismiss(key);
      }}
      onWillAppear={() =>
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: false } })
      }
      onDidAppear={() =>
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: false } })
      }
      onWillDisappear={() =>
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: true } })
      }
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
          />
          <ColumnContent primary={props.primary}>
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
  const threadParams = props.detail.findLast((route) => route.name === "Thread")?.params;
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
      const count = nativeWorkspacePopCount(state, key);
      if (count)
        props.navigation.dispatch({ ...StackActions.pop(count), source: key, target: state.key });
    },
    [props.navigation],
  );

  useEffect(() => {
    // In compact size classes UIKit exposes one column. Selecting a thread
    // changes the visible column without rebuilding either navigation stack.
    if (layout.usesSplitView) return;
    hostRef.current?.show(activeDetailKey ? "secondary" : "primary");
  }, [activeDetailKey, layout.usesSplitView]);

  const primary = props.descriptors[props.primary.key];
  if (!primary) return null;
  return (
    <Split.Host
      ref={hostRef}
      testID="adaptive-workspace-layout"
      preferredSplitBehavior="tile"
      preferredDisplayMode={
        panes.primarySidebarVisible || !activeDetailKey ? "oneBesideSecondary" : "secondaryOnly"
      }
      displayModeButtonVisibility="never"
      presentsWithGesture
      showInspector={inspector.visible}
      onInspectorHide={() => {
        if (inspector.visible) toggleAuxiliaryPane();
      }}
      columnMetrics={{
        minimumPrimaryColumnWidth: 280,
        maximumPrimaryColumnWidth: 380,
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
            onDismiss={handleNativeDismiss}
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
                navigation={props.navigation}
              />
            ) : null;
          })}
        </Split.Stack>
      </Split.Column>
      <Split.Inspector>
        {/* Inspector content supplies its own navigation header. */}
        <Split.HeaderConfig hidden />
        <ColumnContent>
          <View className="flex-1 bg-screen">{inspector.render?.()}</View>
        </ColumnContent>
      </Split.Inspector>
    </Split.Host>
  );
}

function WorkspaceStackView(props: ViewProps) {
  const projection = projectWorkspaceStack(props.state, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return MODAL_FLOWS.has(route.name) || (presentation !== undefined && presentation !== "card");
  });
  // Linking normally restores Home via initialRouteName. A detail-only history
  // must stay a single stack: placeholder descriptors cannot own an interactive
  // sidebar because React Navigation rejects their actions and setOptions.
  const primaryRoute = projection.primary;
  if (!primaryRoute) return <V5StackView {...props} />;
  const primaryDescriptor = props.descriptors[primaryRoute.key]!;
  const baseRoute = { key: `${props.state.key}:workspace`, name: "Workspace" };
  const baseDescriptor: Descriptor = {
    ...primaryDescriptor,
    route: baseRoute,
    options: { headerShown: false },
    render: () => <WorkspaceColumns {...props} primary={primaryRoute} detail={projection.detail} />,
  };
  const overlays = partitionStackPresentations(projection.overlays, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return MODAL_FLOWS.has(route.name) || (presentation !== undefined && presentation !== "card");
  });
  const routes = [baseRoute, ...overlays.map((group) => group[0]!)];
  return (
    <NativeStackView
      {...props}
      state={{ ...props.state, routes, index: routes.length - 1, preloadedRoutes: [] }}
      descriptors={{
        ...Object.fromEntries(
          overlays.map((group) => {
            const route = group[0]!;
            const descriptor = props.descriptors[route.key]!;
            return [
              route.key,
              {
                ...descriptor,
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
  const WorkspaceView = NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? WorkspaceStackView : V5StackView;
  return (
    <NativeWorkspaceModeContext value={NATIVE_WORKSPACE_COLUMNS_SUPPORTED}>
      <NavigationContent>
        <WorkspaceView
          {...rest}
          state={state}
          describe={describe}
          descriptors={descriptors}
          navigation={navigation}
        />
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
