import {
  createNavigatorFactory,
  NavigationContext,
  NavigationRouteContext,
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
import { use, useCallback, useRef, useState, type ComponentProps } from "react";
import { WorkspaceSlotOptionsContext, slotScreenOptions } from "./v5-workspace-context";
import { StyleSheet, View } from "react-native";
import { FormSheet, Stack } from "react-native-screens";
import { NativeScrollEdgeEffectsContext } from "./NativeScrollViewMarker";
import { V5StackHeader } from "./V5StackHeader.ios";
import type { AppNativeStackNavigationOptions } from "./StackHeader";
import { NativeColumnContent } from "./NativeColumnContent.ios";
import {
  nativeStackPopAction,
  nativeWorkspacePopAction,
  nativeWorkspacePopCount,
  partitionStackPresentations,
  reconcileStackScreens,
} from "./workspace-stack-projection";

export type V5StackViewProps = ComponentProps<typeof NativeStackView>;

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
export function V5CardStackView(
  props: V5StackViewProps & { readonly onRootVisibilityChange?: (visible: boolean) => void },
) {
  const { preventedRoutes } = usePreventRemoveContext();
  // Options a screen set inside this workspace tab slot, over its route's.
  const slot = use(WorkspaceSlotOptionsContext);
  const nativePopSource = useRef<string | null>(null);
  const [screens, setScreens] = useState({
    completedNativeDismissals: new Set<string>(),
    nativeCompletingPops: new Set<string>(),
    routes: props.state.routes,
    descriptors: props.descriptors,
    observedRoutes: props.state.routes,
    observedDescriptors: props.descriptors,
  });
  if (
    screens.observedRoutes !== props.state.routes ||
    screens.observedDescriptors !== props.descriptors
  ) {
    const routes = reconcileStackScreens(
      screens.routes,
      props.state.routes,
      screens.completedNativeDismissals,
    );
    const active = new Set(props.state.routes.map((route) => route.key));
    const retainedKeys = new Set(routes.map((route) => route.key));
    setScreens({
      nativeCompletingPops: new Set(
        [...screens.nativeCompletingPops].filter((key) => retainedKeys.has(key)),
      ),
      completedNativeDismissals: new Set(
        [...screens.completedNativeDismissals].filter((key) => active.has(key)),
      ),
      routes,
      descriptors: Object.fromEntries(
        Object.entries({ ...screens.descriptors, ...props.descriptors }).filter(([key]) =>
          retainedKeys.has(key),
        ),
      ),
      observedRoutes: props.state.routes,
      observedDescriptors: props.descriptors,
    });
  }
  // Retain the real descriptor through dismissal; placeholders reject setOptions and dispatch.
  const nativeDismiss = useCallback(
    (key: string) => {
      const state = props.navigation.getState();
      const attached = state.routes.some((route) => route.key === key);
      setScreens((current) => {
        const completedNativeDismissals = new Set(current.completedNativeDismissals);
        const nativeCompletingPops = new Set(current.nativeCompletingPops);
        nativeCompletingPops.delete(key);
        if (attached) {
          completedNativeDismissals.add(key);
          return { ...current, completedNativeDismissals, nativeCompletingPops };
        }
        // Clean delayed callbacks immediately; the router already removed this route and will not update again.
        completedNativeDismissals.delete(key);
        const descriptors = { ...current.descriptors };
        delete descriptors[key];
        return {
          ...current,
          completedNativeDismissals,
          nativeCompletingPops,
          routes: current.routes.filter((route) => route.key !== key),
          descriptors,
        };
      });
      if (nativePopSource.current === key) nativePopSource.current = null;
      const action = nativeStackPopAction(state, key);
      if (action) props.navigation.dispatch(action);
    },
    [props.navigation, setScreens],
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
    [props.navigation, setScreens],
  );
  return (
    <View className="flex-1 bg-screen">
      <Stack.Host>
        {screens.routes.map((route, index) => {
          const descriptor = props.descriptors[route.key] ?? screens.descriptors[route.key];
          if (!descriptor) return null;
          const options = slotScreenOptions(slot, route.key, descriptor.options);
          const attached = props.state.routes.some((current) => current.key === route.key);
          return (
            <Stack.Screen
              key={route.key}
              screenKey={route.key}
              activityMode={
                attached || screens.nativeCompletingPops.has(route.key) ? "attached" : "detached"
              }
              preventNativeDismiss={
                preventedRoutes[route.key]?.preventRemove || options.gestureEnabled === false
              }
              onDismiss={removeDismissed}
              onNativeDismiss={nativeDismiss}
              onNativeDismissPrevented={() => {
                if (preventedRoutes[route.key]?.preventRemove) descriptor.navigation.goBack();
              }}
              onWillAppear={() => {
                if (index === 0) props.onRootVisibilityChange?.(true);
                props.navigation.emit({
                  type: "transitionStart",
                  target: route.key,
                  data: { closing: false },
                });
              }}
              onDidAppear={() => {
                const source = nativePopSource.current;
                if (source === route.key) {
                  nativePopSource.current = null;
                } else if (source) {
                  const state = props.navigation.getState();
                  const action = nativeStackPopAction(state, source, route.key);
                  if (action) {
                    const sourceIndex = state.routes.findIndex((current) => current.key === source);
                    // Keep children until UIKit's dismissal callback; early router removal would enqueue a second pop.
                    const poppedKeys = state.routes
                      .slice(sourceIndex - action.payload.count + 1, sourceIndex + 1)
                      .map((popped) => popped.key);
                    setScreens((current) => ({
                      ...current,
                      nativeCompletingPops: new Set([
                        ...current.nativeCompletingPops,
                        ...poppedKeys,
                      ]),
                    }));
                    nativePopSource.current = null;
                    props.navigation.dispatch(action);
                  }
                }
                props.navigation.emit({
                  type: "transitionEnd",
                  target: route.key,
                  data: { closing: false },
                });
              }}
              onWillDisappear={() => {
                if (index === 0) props.onRootVisibilityChange?.(false);
                const state = props.navigation.getState();
                // Only native Back leaves the disappearing card active; JS navigation already changed history.
                if (state.index > 0 && state.routes[state.index]?.key === route.key) {
                  nativePopSource.current = route.key;
                }
                props.navigation.emit({
                  type: "transitionStart",
                  target: route.key,
                  data: { closing: true },
                });
              }}
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
                  <V5StackHeader
                    options={options}
                    canGoBack={
                      attached
                        ? props.state.routes.findIndex((current) => current.key === route.key) > 0
                        : index > 0
                    }
                  />
                  <NativeColumnContent
                    backgroundColor={StyleSheet.flatten(options.contentStyle)?.backgroundColor}
                    insetHorizontally={
                      (options as AppNativeStackNavigationOptions).nativeContentInsetHorizontally
                    }
                  >
                    <NativeScrollEdgeEffectsContext value={options.scrollEdgeEffects}>
                      {descriptor.render()}
                    </NativeScrollEdgeEffectsContext>
                  </NativeColumnContent>
                </NavigationRouteContext>
              </NavigationContext>
            </Stack.Screen>
          );
        })}
      </Stack.Host>
    </View>
  );
}

export function V5StackView(props: V5StackViewProps) {
  const groups = partitionStackPresentations(props.state.routes, (route) => {
    const presentation = props.descriptors[route.key]?.options.presentation;
    return presentation !== undefined && presentation !== "card";
  });
  const routes = groups.map((group) => group[0]!);
  const descriptors = Object.fromEntries(
    groups.map((group) => {
      const first = group[0]!;
      const descriptor = props.descriptors[first.key]!;
      const visibleRoute = group.at(-1)!;
      return [
        first.key,
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
  );
  return (
    <NativeStackView
      presentationEnvelope
      {...props}
      descriptors={descriptors}
      state={{ ...props.state, routes, index: routes.length - 1, preloadedRoutes: [] }}
    />
  );
}

function V5Navigator({
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
  const StackView = V5StackView;
  return (
    <NavigationContent>
      <StackView
        {...rest}
        state={state}
        describe={describe}
        descriptors={descriptors}
        navigation={navigation}
      />
    </NavigationContent>
  );
}

function V5StackNavigator(props: NativeStackNavigatorProps) {
  return <V5Navigator {...props} />;
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
