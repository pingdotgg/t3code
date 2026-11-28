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
import { NativeWorkspaceTabActivityContext } from "./v5-workspace-context";

const home = { key: "home", name: "Home" };
const thread = { key: "thread", name: "Thread" };

function fire(
  key: string,
  event: "onWillAppear" | "onDidAppear" | "onWillDisappear" | "onDidDisappear",
) {
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

it("ignores root visibility and native pop events from inactive or prewarmed tab slots", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  screens.clear();
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
  const onRootVisibilityChange = vi.fn();
  const onNativePopChange = vi.fn();
  const root = createRoot(document.createElement("div"));
  try {
    // Prewarmed slot only mounts Home (index 0) behind the active tab's Thread.
    act(() =>
      root.render(
        <NativeWorkspaceTabActivityContext
          value={{ active: false, isActive: () => false, headerOnly: true }}
        >
          <V5CardStackView
            {...({
              state: { ...state, index: 0, routes: [home] },
              navigation,
              descriptors: { home: descriptor(home) },
              describe: () => descriptor(home),
            } as unknown as V5StackViewProps)}
            onRootVisibilityChange={onRootVisibilityChange}
            onNativePopChange={onNativePopChange}
          />
        </NativeWorkspaceTabActivityContext>,
      ),
    );

    fire("home", "onWillAppear");
    fire("home", "onWillDisappear");
    expect(onRootVisibilityChange).not.toHaveBeenCalled();
    expect(onNativePopChange).not.toHaveBeenCalled();

    // Retained inactive tab slot (headerOnly: false) must also stay silent.
    screens.clear();
    act(() =>
      root.render(
        <NativeWorkspaceTabActivityContext
          value={{ active: false, isActive: () => false, headerOnly: false }}
        >
          <V5CardStackView
            {...({
              state,
              navigation,
              descriptors: { home: descriptor(home), thread: descriptor(thread) },
              describe: () => descriptor(home),
            } as unknown as V5StackViewProps)}
            onRootVisibilityChange={onRootVisibilityChange}
            onNativePopChange={onNativePopChange}
          />
        </NativeWorkspaceTabActivityContext>,
      ),
    );

    fire("home", "onWillAppear");
    fire("thread", "onWillDisappear");
    expect(onRootVisibilityChange).not.toHaveBeenCalled();
    expect(onNativePopChange).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("clears root visibility when a detail card appears on the active tab slot", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  screens.clear();
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
  const onRootVisibilityChange = vi.fn();
  const root = createRoot(document.createElement("div"));
  try {
    act(() =>
      root.render(
        <NativeWorkspaceTabActivityContext
          value={{ active: true, isActive: () => true, headerOnly: false }}
        >
          <V5CardStackView
            {...({
              state,
              navigation,
              descriptors: { home: descriptor(home), thread: descriptor(thread) },
              describe: () => descriptor(home),
            } as unknown as V5StackViewProps)}
            onRootVisibilityChange={onRootVisibilityChange}
          />
        </NativeWorkspaceTabActivityContext>,
      ),
    );

    // Cold-start notification deep link: Home's initial willAppear arrives before Thread appears.
    fire("home", "onWillAppear");
    expect(onRootVisibilityChange).toHaveBeenLastCalledWith(true);

    fire("thread", "onWillAppear");
    expect(onRootVisibilityChange).toHaveBeenLastCalledWith(false);

    // Interactive back-swipe reveals Home, then cancelling returns to Thread.
    fire("home", "onWillAppear");
    expect(onRootVisibilityChange).toHaveBeenLastCalledWith(true);
    fire("thread", "onDidAppear");
    expect(onRootVisibilityChange).toHaveBeenLastCalledWith(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
