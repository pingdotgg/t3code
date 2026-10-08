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
import { useCallback, useRef, useState, type ComponentProps } from "react";
import { StyleSheet, View } from "react-native";
import { FormSheet, Stack } from "react-native-screens";
import { V5StackHeader } from "./V5StackHeader.ios";
import { NativeColumnContent } from "./NativeColumnContent.ios";
import {
  nativeStackPopAction,
  nativeWorkspacePopAction,
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
  // Keep the real descriptor through dismissal. describe(route, true) creates
  // a placeholder whose navigation rejects setOptions and dispatches.
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
        // A delayed callback needs immediate cleanup: the router already
        // removed the route, so no further router update will follow.
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
          const attached = props.state.routes.some((current) => current.key === route.key);
          return (
            <Stack.Screen
              key={route.key}
              screenKey={route.key}
              activityMode={
                attached || screens.nativeCompletingPops.has(route.key) ? "attached" : "detached"
              }
              preventNativeDismiss={
                preventedRoutes[route.key]?.preventRemove ||
                descriptor.options.gestureEnabled === false
              }
              onDismiss={removeDismissed}
              onNativeDismiss={nativeDismiss}
              onNativeDismissPrevented={() => {
                if (preventedRoutes[route.key]?.preventRemove) descriptor.navigation.goBack();
              }}
              onWillAppear={() =>
                props.navigation.emit({
                  type: "transitionStart",
                  target: route.key,
                  data: { closing: false },
                })
              }
              onDidAppear={() => {
                const source = nativePopSource.current;
                if (source === route.key) {
                  // A cancelled swipe restores its source without changing router history.
                  nativePopSource.current = null;
                } else if (source) {
                  const state = props.navigation.getState();
                  const action = nativeStackPopAction(state, source, route.key);
                  if (action) {
                    const sourceIndex = state.routes.findIndex((current) => current.key === source);
                    // UIKit owns this pop. Keep these children attached until its
                    // dismissal callback, so the early router update cannot enqueue a second pop.
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
                const state = props.navigation.getState();
                // JS pushes/pops already changed history. Only native Back leaves
                // the disappearing card at the router's active index.
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
                    options={descriptor.options}
                    canGoBack={
                      attached
                        ? props.state.routes.findIndex((current) => current.key === route.key) > 0
                        : index > 0
                    }
                  />
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

/** Keep a direct card host mounted while v5 form sheets present above it. */
export function V5SheetStackView(props: V5StackViewProps) {
  const { preventedRoutes } = usePreventRemoveContext();
  const groups = partitionStackPresentations(
    props.state.routes,
    (route) => props.descriptors[route.key]?.options.presentation === "formSheet",
  );
  const [retained, setRetained] = useState({
    groups: groups.slice(1),
    descriptors: props.descriptors,
    observedRoutes: props.state.routes,
    observedDescriptors: props.descriptors,
  });
  if (
    retained.observedRoutes !== props.state.routes ||
    retained.observedDescriptors !== props.descriptors
  ) {
    const active = new Set(groups.slice(1).map((group) => group[0]!.key));
    const sheets = [
      ...groups.slice(1),
      ...retained.groups.filter((group) => !active.has(group[0]!.key)),
    ];
    const sheetKeys = new Set(sheets.flatMap((group) => group.map((route) => route.key)));
    setRetained({
      groups: sheets,
      descriptors: Object.fromEntries(
        Object.entries({ ...retained.descriptors, ...props.descriptors }).filter(([key]) =>
          sheetKeys.has(key),
        ),
      ),
      observedRoutes: props.state.routes,
      observedDescriptors: props.descriptors,
    });
  }
  const removeSheet = (key: string) => {
    setRetained((current) => {
      const sheets = current.groups.filter((group) => group[0]!.key !== key);
      const sheetKeys = new Set(sheets.flatMap((group) => group.map((route) => route.key)));
      return {
        ...current,
        groups: sheets,
        descriptors: Object.fromEntries(
          Object.entries(current.descriptors).filter(([routeKey]) => sheetKeys.has(routeKey)),
        ),
      };
    });
  };
  const base = groups[0] ?? [];
  return (
    <View className="flex-1 bg-screen">
      <V5CardStackView
        {...props}
        state={{ ...props.state, routes: base, index: base.length - 1, preloadedRoutes: [] }}
      />
      {retained.groups.map((group) => {
        const first = group[0]!;
        const descriptor = props.descriptors[first.key] ?? retained.descriptors[first.key];
        if (!descriptor) return null;
        const options = descriptor.options;
        const attached = nativeWorkspacePopCount(props.state, first.key) > 0;
        return (
          <FormSheet
            key={first.key}
            isOpen={attached}
            detents={options.sheetAllowedDetents}
            initialDetentIndex={options.sheetInitialDetentIndex}
            largestUndimmedDetentIndex={options.sheetLargestUndimmedDetentIndex}
            prefersGrabberVisible={options.sheetGrabberVisible}
            preferredCornerRadius={options.sheetCornerRadius}
            prefersScrollingExpandsWhenScrolledToEdge={options.sheetExpandsWhenScrolledToEdge}
            nativeContainerStyle={{
              backgroundColor: StyleSheet.flatten(options.contentStyle)?.backgroundColor,
            }}
            preventNativeDismiss={
              group.some((route) => preventedRoutes[route.key]?.preventRemove) ||
              options.gestureEnabled === false
            }
            onNativeDismissPrevented={() => {
              const guarded = group.findLast((route) => preventedRoutes[route.key]?.preventRemove);
              if (guarded) {
                const state = props.navigation.getState();
                const action = nativeWorkspacePopAction(state, first.key);
                if (action) props.navigation.dispatch(action);
              }
            }}
            onDismiss={() => removeSheet(first.key)}
            onNativeDismiss={() => {
              const state = props.navigation.getState();
              const action = nativeWorkspacePopAction(state, first.key);
              if (action) props.navigation.dispatch(action);
              removeSheet(first.key);
            }}
          >
            <V5CardStackView
              {...props}
              descriptors={{ ...retained.descriptors, ...props.descriptors }}
              state={{
                ...props.state,
                routes: group,
                index: group.length - 1,
                preloadedRoutes: [],
              }}
            />
          </FormSheet>
        );
      })}
    </View>
  );
}

function V5Navigator({
  nativeSheets,
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
}: NativeStackNavigatorProps & { readonly nativeSheets?: boolean }) {
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
  const StackView = nativeSheets ? V5SheetStackView : V5StackView;
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

function V5SheetStackNavigator(props: NativeStackNavigatorProps) {
  return <V5Navigator {...props} nativeSheets />;
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

/** For navigators whose presentations are cards and form sheets only. */
export function createV5SheetStackNavigator<
  const ParamList extends ParamListBase,
  const NavigatorID extends string | undefined = string | undefined,
  const TypeBag extends NavigatorTypeBagBase = V5TypeBag<ParamList, NavigatorID>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(V5SheetStackNavigator)(config);
}
