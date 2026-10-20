import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type NavigationState,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import { rememberedThreadWorkspaceNavigationState } from "../workspace/threadWorkspaceNavigationMemory";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;

export function createHomeThreadNavigationAction(input: {
  readonly state: Pick<NavigationState, "index" | "routes">;
  readonly dismissingRouteKey: string | null;
  readonly thread: ThreadSelection;
  readonly rememberedState?: ReturnType<typeof rememberedThreadWorkspaceNavigationState>;
}) {
  const currentRoute = input.state.routes[input.state.index];
  const params = {
    environmentId: input.thread.environmentId,
    threadId: input.thread.id,
  };

  if (input.rememberedState) return CommonActions.reset(input.rememberedState);

  // Native swipe-back pops the outgoing route after its animation. Reusing
  // that key would also discard this selection when the dismissal arrives.
  if (input.dismissingRouteKey !== null && currentRoute?.key === input.dismissingRouteKey) {
    return StackActions.push("Thread", params);
  }

  return CommonActions.navigate("Thread", params);
}

export function useHomeThreadSelection() {
  const navigation =
    useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList, "Home">>();
  const dismissingRouteKey = useRef<string | null>(null);
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();

  useEffect(() => {
    const clear = () => {
      dismissingRouteKey.current = null;
    };
    // This listener belongs to Home, so swipe-back is its opening transition.
    // Thread's closing event is targeted at the outgoing Thread route.
    const removeTransitionStart = navigation.addListener("transitionStart", ({ data }) => {
      const state = navigation.getState();
      const currentRoute = state.routes[state.index];
      dismissingRouteKey.current =
        !data.closing && currentRoute?.name === "Thread" ? currentRoute.key : null;
    });
    const removeFocus = navigation.addListener("focus", clear);

    return () => {
      clear();
      removeTransitionStart();
      removeFocus();
    };
  }, [navigation]);

  return useCallback(
    (thread: ThreadSelection) => {
      if (Platform.OS === "android") {
        selectAndroidWorkspace({
          name: "Thread",
          params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
        });
        return;
      }
      navigation.dispatch((state) =>
        createHomeThreadNavigationAction({
          state,
          dismissingRouteKey: dismissingRouteKey.current,
          thread,
          rememberedState: rememberedThreadWorkspaceNavigationState(state, {
            environmentId: String(thread.environmentId),
            threadId: String(thread.id),
          }),
        }),
      );
    },
    [navigation, selectAndroidWorkspace],
  );
}
