import type { ParamListBase, StackNavigationState } from "@react-navigation/native";
import { act, createContext, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Stack as NativeStack } from "react-native-screens";
import { expect, it, vi } from "vite-plus/test";

type ScreenProps = ComponentProps<typeof NativeStack.Screen>;
const screens = vi.hoisted(() => new Map<string, ScreenProps>());

vi.mock("react-native", () => ({
  StyleSheet: { flatten: (style: unknown) => style },
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native-screens", () => ({
  Stack: {
    Host: ({ children }: { children?: ReactNode }) => children,
    Screen: (props: ScreenProps) => {
      screens.set(props.screenKey, props);
      return null;
    },
  },
}));
vi.mock("@react-navigation/native", () => ({
  NavigationContext: createContext(undefined),
  NavigationRouteContext: createContext(undefined),
  usePreventRemoveContext: () => ({ preventedRoutes: {} }),
}));
vi.mock("@react-navigation/native-stack", () => ({ NativeStackView: () => null }));
vi.mock("./V5StackHeader.ios", () => ({ V5StackHeader: () => null }));
vi.mock("./NativeColumnContent.ios", () => ({ NativeColumnContent: () => null }));
vi.mock("./NativeScrollViewMarker", () => ({
  NativeScrollEdgeEffectsContext: createContext(undefined),
}));

import { V5CardStackView, type V5StackViewProps } from "./createV5StackNavigator.ios";

const home = { key: "home", name: "Home" };
const thread = { key: "thread", name: "Thread" };

function fire(key: string, event: "onWillAppear" | "onWillDisappear" | "onDidDisappear") {
  const handler = screens.get(key)?.[event] as (() => void) | undefined;
  if (!handler) throw new Error(`No ${event} for ${key}`);
  act(() => handler());
}

it("forgets native Back when a full-screen presentation covers the top card", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const state: StackNavigationState<ParamListBase> = {
    key: "stack",
    type: "stack",
    stale: false,
    index: 1,
    routeNames: ["Home", "Thread"],
    routes: [home, thread],
    preloadedRoutes: [],
  };
  const navigation = { getState: () => state, emit: vi.fn(), dispatch: vi.fn() };
  const descriptor = (route: typeof home) => ({
    route,
    navigation,
    options: {},
    render: () => null,
  });
  const onNativePopChange = vi.fn();
  const root = createRoot(document.createElement("div"));
  try {
    act(() =>
      root.render(
        <V5CardStackView
          {...({
            state,
            navigation,
            descriptors: { home: descriptor(home), thread: descriptor(thread) },
            describe: () => descriptor(home),
          } as unknown as V5StackViewProps)}
          onNativePopChange={onNativePopChange}
        />,
      ),
    );

    // A presentation covers the thread: nothing in the stack appears beneath it.
    fire("thread", "onWillDisappear");
    fire("thread", "onDidDisappear");
    expect(onNativePopChange).toHaveBeenLastCalledWith(null);

    // Native Back reveals Home, so the thread stays the card being popped.
    fire("thread", "onWillDisappear");
    fire("home", "onWillAppear");
    fire("thread", "onDidDisappear");
    expect(onNativePopChange).toHaveBeenLastCalledWith("thread");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
