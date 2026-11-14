import {
  createNavigatorFactory,
  NavigationContainer,
  NavigationIndependentTree,
  StackRouter,
  useNavigation,
  useNavigationBuilder,
  type NavigatorTypeBagBase,
  type ParamListBase,
  type RouteProp,
  type StackActionHelpers,
  type StackNavigationState,
  type StackRouterOptions,
  type StaticConfig,
  type TypedNavigator,
} from "@react-navigation/native";
import type {
  NativeStackNavigationEventMap,
  NativeStackNavigationOptions,
  NativeStackNavigatorProps,
  NativeStackTypeBag,
} from "@react-navigation/native-stack";
import type { ReactNode } from "react";

import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";

function ThreadPreviewNavigator({
  id,
  initialRouteName,
  UNSTABLE_routeNamesChangeBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
}: NativeStackNavigatorProps) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder<
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
  const route = state.routes[state.index];
  return <NavigationContent>{route ? descriptors[route.key]?.render() : null}</NavigationContent>;
}

type ThreadPreviewTypeBag<ParamList extends ParamListBase> = Omit<
  NativeStackTypeBag<ParamList, undefined>,
  "Navigator"
> & { Navigator: typeof ThreadPreviewNavigator };

function createThreadPreviewNavigator<
  const ParamList extends ParamListBase,
  const TypeBag extends NavigatorTypeBagBase = ThreadPreviewTypeBag<ParamList>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(ThreadPreviewNavigator)(config);
}

type ThreadPreviewParams = { readonly environmentId: string; readonly threadId: string };

const Preview = createThreadPreviewNavigator<{ Thread: ThreadPreviewParams }>();

/**
 * A `Thread` route of its own for a thread shown inside another screen. Thread state resolves the
 * thread from route params, so the preview needs its own params, and its `replace` must not swap
 * the host thread. Draws no native UI; actions it can't handle go to the host.
 */
export function ThreadPreviewRoute(
  props: ThreadPreviewParams & {
    readonly children: (route: RouteProp<{ Thread: ThreadPreviewParams }, "Thread">) => ReactNode;
  },
) {
  const host = useNavigation();
  const theme = useMobileNavigationTheme();
  const { environmentId, threadId } = props;
  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={theme} onUnhandledAction={host.dispatch}>
        <Preview.Navigator key={`${environmentId}:${threadId}`}>
          <Preview.Screen name="Thread" initialParams={{ environmentId, threadId }}>
            {(screen) => props.children(screen.route)}
          </Preview.Screen>
        </Preview.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}
