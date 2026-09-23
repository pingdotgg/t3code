import {
  createNavigatorFactory,
  NavigationContext,
  NavigationRouteContext,
  StackActions,
  StackRouter,
  useNavigationBuilder,
  usePreventRemoveContext,
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
import { useCallback, useState, type ComponentProps } from "react";
import { View } from "react-native";
import { Stack } from "react-native-screens";
import { V5StackHeader } from "./V5StackHeader.ios";
import { NativeColumnContent } from "./NativeColumnContent.ios";
import {
  nativeWorkspacePopCount,
  partitionStackPresentations,
  reconcileStackScreens,
} from "./workspace-stack-projection";

export type V5StackViewProps = ComponentProps<typeof NativeStackView>;

/** The presentation envelope must not mount a second search bar or header. */
export function modalEnvelopeOptions(options: NativeStackNavigationOptions) {
  return {
    ...Object.fromEntries(
      Object.entries(options).filter(
        ([key]) =>
          !key.startsWith("header") &&
          !key.startsWith("unstable_header") &&
          key !== "unstable_navigationItemStyle",
      ),
    ),
    headerShown: false,
  };
}

/** Keep outgoing screens until UIKit completes its pop, as required by v5. */
export function V5CardStackView(props: V5StackViewProps) {
  const { preventedRoutes } = usePreventRemoveContext();
  const [screens, setScreens] = useState({
    routes: props.state.routes,
    descriptors: props.descriptors,
    observedRoutes: props.state.routes,
    observedDescriptors: props.descriptors,
  });
  if (
    screens.observedRoutes !== props.state.routes ||
    screens.observedDescriptors !== props.descriptors
  ) {
    setScreens({
      routes: reconcileStackScreens(screens.routes, props.state.routes),
      descriptors: { ...screens.descriptors, ...props.descriptors },
      observedRoutes: props.state.routes,
      observedDescriptors: props.descriptors,
    });
  }
  // Keep the real descriptor through dismissal. describe(route, true) creates
  // a placeholder whose navigation rejects setOptions and dispatches.
  const nativeDismiss = useCallback(
    (key: string) => {
      const state = props.navigation.getState();
      const count = nativeWorkspacePopCount(state, key);
      if (count)
        props.navigation.dispatch({ ...StackActions.pop(count), source: key, target: state.key });
    },
    [props.navigation],
  );
  const removeDismissed = useCallback(
    (key: string) => {
      if (!props.navigation.getState().routes.some((route) => route.key === key)) {
        setScreens((current) => {
          const descriptors = { ...current.descriptors };
          delete descriptors[key];
          return {
            ...current,
            routes: current.routes.filter((route) => route.key !== key),
            descriptors,
          };
        });
      }
    },
    [props.navigation],
  );
  return (
    <View className="flex-1 bg-screen">
      <Stack.Host>
        {screens.routes.map((route, index) => {
          const descriptor = props.descriptors[route.key] ?? screens.descriptors[route.key];
          if (!descriptor) return null;
          const attached = props.state.routes.some((current) => current.key === route.key);
          return (
            <Stack.Screen
              key={route.key}
              screenKey={route.key}
              activityMode={attached ? "attached" : "detached"}
              preventNativeDismiss={
                preventedRoutes[route.key]?.preventRemove ||
                descriptor.options.gestureEnabled === false
              }
              onDismiss={removeDismissed}
              onNativeDismiss={nativeDismiss}
              onNativeDismissPrevented={() => descriptor.navigation.goBack()}
              onWillAppear={() =>
                props.navigation.emit({
                  type: "transitionStart",
                  target: route.key,
                  data: { closing: false },
                })
              }
              onDidAppear={() =>
                props.navigation.emit({
                  type: "transitionEnd",
                  target: route.key,
                  data: { closing: false },
                })
              }
              onWillDisappear={() =>
                props.navigation.emit({
                  type: "transitionStart",
                  target: route.key,
                  data: { closing: true },
                })
              }
              onDidDisappear={() =>
                props.navigation.emit({
                  type: "transitionEnd",
                  target: route.key,
                  data: { closing: true },
                })
              }
            >
              <NavigationContext value={descriptor.navigation}>
                <NavigationRouteContext value={descriptor.route}>
                  <V5StackHeader options={descriptor.options} canGoBack={index > 0} />
                  <NativeColumnContent>{descriptor.render()}</NativeColumnContent>
                </NavigationRouteContext>
              </NavigationContext>
            </Stack.Screen>
          );
        })}
      </Stack.Host>
    </View>
  );
}

/** v5 owns pushes and headers; the legacy renderer only presents modal groups. */
export function V5StackView(props: V5StackViewProps) {
  const groups = partitionStackPresentations(props.state.routes, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return (
      ["SettingsSheet", "NewTaskSheet"].includes(route.name) ||
      (presentation !== undefined && presentation !== "card")
    );
  });
  const routes = groups.map((group) => group[0]!);
  const descriptors = Object.fromEntries(
    groups.map((group) => {
      const first = group[0]!;
      const descriptor = props.descriptors[first.key]!;
      return [
        first.key,
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
  );
  return (
    <NativeStackView
      {...props}
      descriptors={descriptors}
      state={{ ...props.state, routes, index: routes.length - 1, preloadedRoutes: [] }}
    />
  );
}

function V5StackNavigator({
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
  return (
    <NavigationContent>
      <V5StackView
        {...rest}
        state={state}
        describe={describe}
        descriptors={descriptors}
        navigation={navigation}
      />
    </NavigationContent>
  );
}

type V5TypeBag<ParamList extends ParamListBase, NavigatorID extends string | undefined> = Omit<
  NativeStackTypeBag<ParamList, NavigatorID>,
  "Navigator"
> & { Navigator: typeof V5StackNavigator };
export function createV5StackNavigator<
  const ParamList extends ParamListBase,
  const NavigatorID extends string | undefined = string | undefined,
  const TypeBag extends NavigatorTypeBagBase = V5TypeBag<ParamList, NavigatorID>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(V5StackNavigator)(config);
}
