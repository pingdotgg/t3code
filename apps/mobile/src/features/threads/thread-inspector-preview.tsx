import {
  NavigationContainer,
  NavigationIndependentTree,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { View } from "react-native";

import { IconButton } from "../../components/ui/IconButton";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeInspectorContent } from "../../native/NativeInspectorContent";
import { createV5StackNavigator } from "../../native/createV5StackNavigator";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { WorkspaceSlotOptionsContext } from "../../native/v5-workspace-context";
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

export interface ThreadInspectorPresentation {
  readonly onClose: () => void;
  readonly onMaximize?: () => void;
}

export function ThreadInspectorHeader(
  props: ThreadInspectorPresentation & { readonly title: string },
) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: true, headerTransparent: true }} />
      <SheetHeader
        title={props.title}
        onClose={props.onClose}
        accessibilityLabel="Close thread preview"
        trailing={
          props.onMaximize ? (
            <IconButton
              icon="arrow.up.left.and.arrow.down.right"
              accessibilityLabel="Maximize thread"
              onPress={props.onMaximize}
            />
          ) : undefined
        }
      />
    </>
  );
}

const PreviewStack = createV5StackNavigator<{
  Thread: { readonly environmentId: string; readonly threadId: string };
}>();

export function InspectorContentScope({ children }: { readonly children: ReactNode }) {
  return (
    <WorkspaceSlotOptionsContext value={null}>
      <WorkspaceContentWidthContext value={null}>
        <WorkspaceSettledContentWidthContext value={null}>
          {children}
        </WorkspaceSettledContentWidthContext>
      </WorkspaceContentWidthContext>
    </WorkspaceSlotOptionsContext>
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
        <NativeInspectorContent>
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
                  <PreviewStack.Navigator
                    key={`${target.environmentId}:${target.threadId}`}
                    screenOptions={{ headerBackVisible: false }}
                  >
                    <PreviewStack.Screen name="Thread" initialParams={target}>
                      {(screen) =>
                        props.renderThread({
                          route: screen.route,
                          inspectorPresentation: {
                            onClose: props.onClose,
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
        </NativeInspectorContent>
      </InspectorContentScope>
    </ThreadInspectorNavigationContext>
  );
}
