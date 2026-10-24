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
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;

export function createHomeThreadRouteAction(input: {
  readonly state: Pick<NavigationState, "index" | "routes">;
  readonly dismissingRouteKey: string | null;
  readonly params: ReactNavigation.RootParamList["Thread"];
}) {
  const currentRoute = input.state.routes[input.state.index];
  if (input.dismissingRouteKey !== null && currentRoute?.key === input.dismissingRouteKey) {
    return StackActions.push("Thread", input.params);
  }
  if (currentRoute?.name === "Thread") {
    return {
      ...CommonActions.setParams({
        environmentId: undefined,
        threadId: undefined,
        draft: undefined,
        ...input.params,
      }),
      source: currentRoute.key,
    };
  }
  return CommonActions.navigate("Thread", input.params);
}

export function createHomeThreadNavigationAction(input: {
  readonly state: Pick<NavigationState, "index" | "routes">;
  readonly dismissingRouteKey: string | null;
  readonly thread: ThreadSelection;
}) {
  return createHomeThreadRouteAction({
    ...input,
    params: {
      environmentId: input.thread.environmentId,
      threadId: input.thread.id,
    },
  });
}

export function useHomeThreadRouteSelection() {
  const navigation =
    useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList, "Home">>();
  const dismissingRouteKey = useRef<string | null>(null);
  const { layout, setPrimarySidebarVisible } = useAdaptiveWorkspaceLayout();
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
    (params: ReactNavigation.RootParamList["Thread"]) => {
      if (Platform.OS === "android") {
        selectAndroidWorkspace({
          name: "Thread",
          params,
        });
        return;
      }
      if (layout.primarySidebarOverlaysContent) setPrimarySidebarVisible(false);
      navigation.dispatch((state) =>
        createHomeThreadRouteAction({
          state,
          dismissingRouteKey: dismissingRouteKey.current,
          params,
        }),
      );
    },
    [
      layout.primarySidebarOverlaysContent,
      navigation,
      selectAndroidWorkspace,
      setPrimarySidebarVisible,
    ],
  );
}

export function useHomeThreadSelection() {
  const selectRoute = useHomeThreadRouteSelection();
  return useCallback(
    (thread: ThreadSelection) =>
      selectRoute({ environmentId: thread.environmentId, threadId: thread.id }),
    [selectRoute],
  );
}
