// @vitest-environment jsdom
import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// React Navigation's core runs in jsdom; the native package also loads React Native.
const navigation = await vi.hoisted(async () => {
  const NodeModule = await import("node:module");
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const core = NodeModule.createRequire(nativePackage).resolve("@react-navigation/core");
  return (await import(core)) as typeof import("@react-navigation/native");
});
vi.mock("@react-navigation/native", () => navigation);
vi.mock("react-native", () => ({ Keyboard: { dismiss: vi.fn() } }));

const { useAndroidWorkspaceSelection } = await import("./useAndroidWorkspaceSelection");

function TestStackNavigator(
  props: {
    readonly children: ReactNode;
    readonly initialRouteName?: string;
  } & Pick<Parameters<typeof navigation.useNavigationBuilder>[1], "layout">,
) {
  const { state, descriptors, NavigationContent } = navigation.useNavigationBuilder(
    navigation.StackRouter,
    props,
  );
  const focused = state.routes[state.index];
  return (
    <NavigationContent>{focused ? descriptors[focused.key]?.render() : null}</NavigationContent>
  );
}

const Stack = navigation.createNavigatorFactory(TestStackNavigator)();

function SettingsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Settings" component={() => null} />
      <Stack.Screen name="SettingsFollowUps" component={() => null} />
    </Stack.Navigator>
  );
}

type SelectWorkspace = ReturnType<typeof useAndroidWorkspaceSelection>;

function Sidebar(props: { readonly onReady: (select: SelectWorkspace) => void }) {
  const select = useAndroidWorkspaceSelection();
  const { onReady } = props;
  useEffect(() => onReady(select), [onReady, select]);
  return null;
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("useAndroidWorkspaceSelection", () => {
  it("opens a thread from the workspace layout while nested Settings has focus", () => {
    const container = navigation.createNavigationContainerRef();
    let select: SelectWorkspace | undefined;
    const onReady = (next: SelectWorkspace) => {
      select = next;
    };
    // The real sidebar renders in the root navigator's layout, outside any screen.
    const layout = ({ children }: { readonly children: ReactNode }) => (
      <>
        <Sidebar onReady={onReady} />
        {children}
      </>
    );
    const initialState = {
      index: 2,
      routes: [
        { name: "Home" },
        { name: "Thread", params: { environmentId: "environment-a", threadId: "thread-a" } },
        {
          name: "SettingsSheet",
          state: { index: 1, routes: [{ name: "Settings" }, { name: "SettingsFollowUps" }] },
        },
      ],
    } satisfies ComponentProps<typeof navigation.BaseNavigationContainer>["initialState"];
    root = createRoot(document.createElement("div"));
    act(() =>
      root?.render(
        <navigation.BaseNavigationContainer ref={container} initialState={initialState}>
          <Stack.Navigator layout={layout}>
            <Stack.Screen name="Home" component={() => null} />
            <Stack.Screen name="Thread" component={() => null} />
            <Stack.Screen name="SettingsSheet" component={SettingsStack} />
          </Stack.Navigator>
        </navigation.BaseNavigationContainer>,
      ),
    );

    act(() =>
      select?.({
        name: "Thread",
        params: { environmentId: "environment-a", threadId: "thread-b" },
      }),
    );

    const state = container.getRootState();
    expect(state?.routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
    expect(state?.routes[state.index]?.params).toEqual({
      environmentId: "environment-a",
      threadId: "thread-b",
    });
  });
});
