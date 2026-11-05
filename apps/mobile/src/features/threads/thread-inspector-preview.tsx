import {
  createNavigatorFactory,
  NavigationContainer,
  NavigationIndependentTree,
  StackRouter,
  useIsFocused,
  useNavigation,
  useNavigationBuilder,
  type NavigatorTypeBagBase,
  type ParamListBase,
  type StackActionHelpers,
  type StackNavigationState,
  type StackRouterOptions,
  type StaticConfig,
  type StaticScreenProps,
  type TypedNavigator,
} from "@react-navigation/native";
import type {
  NativeStackNavigationEventMap,
  NativeStackNavigationOptions,
  NativeStackNavigatorProps,
  NativeStackTypeBag,
} from "@react-navigation/native-stack";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";
import { DevicePreviewScreen } from "../devices/DevicePreviewRouteScreen";
import {
  WorkspaceContentWidthContext,
  WorkspaceSettledContentWidthContext,
} from "../layout/workspace-content-width";
import {
  ThreadInspectorNavigationContext,
  type ThreadInspectorTarget,
} from "./thread-inspector-navigation";

/** A thread shown outside its route: in the inspector pane, or presented full screen with a close. */
export type ThreadInspectorPresentation =
  | { readonly onMaximize: () => void }
  | { readonly onClose: () => void };

export function ThreadInspectorHeader(
  props: ThreadInspectorPresentation & { readonly title: string },
) {
  if ("onMaximize" in props) {
    return (
      <AppBar
        title={props.title}
        actions={[
          {
            accessibilityLabel: "Maximize thread",
            icon: "arrow.up.left.and.arrow.down.right",
            onPress: props.onMaximize,
          },
        ]}
      />
    );
  }
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: true, headerTransparent: true }} />
      <SheetHeader title={props.title} onClose={props.onClose} accessibilityLabel="Close thread" />
    </>
  );
}

/**
 * Gives the previewed thread a route of its own, so its route hooks and actions never reach the
 * host thread. It draws nothing: the thread's AppBar writes into the pane's bar.
 */
function PreviewRouteNavigator({
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

type PreviewTypeBag<ParamList extends ParamListBase> = Omit<
  NativeStackTypeBag<ParamList, undefined>,
  "Navigator"
> & { Navigator: typeof PreviewRouteNavigator };
function createPreviewRouteNavigator<
  const ParamList extends ParamListBase,
  const TypeBag extends NavigatorTypeBagBase = PreviewTypeBag<ParamList>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(PreviewRouteNavigator)(config);
}

const PreviewStack = createPreviewRouteNavigator<{
  Thread: { readonly environmentId: string; readonly threadId: string };
}>();

/** A thread shown beside or over the workspace does not take the workspace's content width. */
export function InspectorContentScope({ children }: { readonly children: ReactNode }) {
  return (
    <WorkspaceContentWidthContext value={null}>
      <WorkspaceSettledContentWidthContext value={null}>
        {children}
      </WorkspaceSettledContentWidthContext>
    </WorkspaceContentWidthContext>
  );
}

export function ThreadInspectorPreview(props: {
  readonly target: ThreadInspectorTarget;
  readonly onClose: () => void;
  readonly onOpen: (target: ThreadInspectorTarget) => void;
  readonly renderThread: (
    props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }> & {
      readonly inspectorPresentation: ThreadInspectorPresentation;
    },
  ) => ReactNode;
}) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const theme = useMobileNavigationTheme();
  const { target } = props;
  const maximizeDevice = (deviceKey: string | null) => {
    props.onOpen({ ...target, deviceKey: deviceKey ?? undefined });
    navigation.navigate("ThreadDevicePreview", {
      environmentId: target.environmentId,
      threadId: target.threadId,
      deviceKey: deviceKey ?? undefined,
    });
  };
  if (!focused) return null;
  return (
    <ThreadInspectorNavigationContext value={props.onOpen}>
      <InspectorContentScope>
        {target.type === "device" ? (
          <DevicePreviewScreen
            key={`${target.environmentId}:${target.threadId}`}
            environmentId={EnvironmentId.make(target.environmentId)}
            threadId={ThreadId.make(target.threadId)}
            initialDeviceKey={target.deviceKey}
            onClose={props.onClose}
            onMaximize={maximizeDevice}
          />
        ) : (
          <View className="flex-1 bg-screen">
            <NavigationIndependentTree>
              <NavigationContainer theme={theme} onUnhandledAction={navigation.dispatch}>
                <PreviewStack.Navigator key={`${target.environmentId}:${target.threadId}`}>
                  <PreviewStack.Screen name="Thread" initialParams={target}>
                    {(screen) =>
                      props.renderThread({
                        route: screen.route,
                        inspectorPresentation: {
                          onMaximize: () =>
                            navigation.navigate("ThreadInspectorFullscreen", {
                              environmentId: screen.route.params.environmentId,
                              threadId: screen.route.params.threadId,
                            }),
                        },
                      })
                    }
                  </PreviewStack.Screen>
                </PreviewStack.Navigator>
              </NavigationContainer>
            </NavigationIndependentTree>
          </View>
        )}
      </InspectorContentScope>
    </ThreadInspectorNavigationContext>
  );
}
