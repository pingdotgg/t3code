import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { act, createContext, startTransition, Suspense, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

type HeaderOptions = {
  unstable_headerLeftItems?: () => NativeStackHeaderItem[];
  unstable_headerRightItems?: () => NativeStackHeaderItem[];
  unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
};

const harness = vi.hoisted(() => ({
  params: { path: ["first", "guide.pdf"] },
  appliedOptions: {} as HeaderOptions,
  renderedItems: [] as NativeStackHeaderItem[],
  setOptionsCalls: 0,
}));

// Native headers retain the actions materialized when navigation applies options. Like React
// Navigation, the header renders again only when the options are no longer shallowly equal.
vi.mock("@react-navigation/native", async () => {
  // vi.mock factories run before the file's imports.
  const { createContext } = await vi.importActual<typeof import("react")>("react");
  const navigation = {
    setOptions(options: HeaderOptions) {
      harness.setOptionsCalls += 1;
      const previous: Record<string, unknown> = harness.appliedOptions;
      const next: Record<string, unknown> = { ...previous, ...options };
      harness.appliedOptions = next;
      if (
        Object.keys(next).length === Object.keys(previous).length &&
        Object.keys(next).every((key) => next[key] === previous[key])
      )
        return;
      harness.renderedItems =
        options.unstable_headerLeftItems?.() ??
        options.unstable_headerRightItems?.() ??
        options.unstable_headerToolbarItems?.() ??
        [];
    },
  };
  return {
    // Outside a workspace tab slot the header writes to the route's navigation.
    NavigationRouteContext: createContext(undefined),
    useNavigation: () => navigation,
    useRoute: () => ({ key: "file", name: "ThreadFile", params: harness.params }),
  };
});

import { NativeHeaderToolbar } from "./NativeHeaderToolbar";

let root: Root | null = null;

// Like React Navigation's NavigationStateContext, whose default value throws when
// read. React restores a context's default outside render, so layout effects see it.
const ContainerStateContext = createContext<object>({
  get getIsInitial(): never {
    throw new Error("Couldn't find a navigation context.");
  },
});
const containerState = {};

function ConnectingToolbar(props: { readonly label: string }) {
  return (
    <NativeHeaderToolbar placement="right">
      <NativeHeaderToolbar.Custom>
        <span aria-label={props.label} />
      </NativeHeaderToolbar.Custom>
    </NativeHeaderToolbar>
  );
}

function renderConnecting(label: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root ??= createRoot(document.createElement("div"));
  act(() =>
    root!.render(
      <ContainerStateContext value={containerState}>
        <ConnectingToolbar label={label} />
      </ContainerStateContext>,
    ),
  );
}

function renderedCustomLabel() {
  const item = harness.renderedItems[0];
  if (item?.type !== "custom") throw new Error("Expected the custom header element");
  return (item.element as ReactElement<{ "aria-label": string }>).props["aria-label"];
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.appliedOptions = {};
  harness.renderedItems = [];
  harness.setOptionsCalls = 0;
  vi.unstubAllGlobals();
});

it.each(["left", "right", "bottom"] as const)(
  "dispatches retained %s actions to the latest committed handlers without registering again",
  (placement) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    const onPress = vi.fn();
    const render = (path: string) =>
      act(() =>
        root!.render(
          <NativeHeaderToolbar placement={placement}>
            <NativeHeaderToolbar.Button label="Open" onPress={() => onPress("button", path)} />
            <NativeHeaderToolbar.Menu title="File">
              <NativeHeaderToolbar.MenuAction onPress={() => onPress("menu", path)}>
                Open
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.Menu title="More">
                <NativeHeaderToolbar.MenuAction onPress={() => onPress("nested", path)}>
                  Open
                </NativeHeaderToolbar.MenuAction>
              </NativeHeaderToolbar.Menu>
            </NativeHeaderToolbar.Menu>
          </NativeHeaderToolbar>,
        ),
      );

    render("first/guide.pdf");
    const [button, menu] = harness.renderedItems;
    if (button?.type !== "button" || menu?.type !== "menu") {
      throw new Error("Expected the native button and menu");
    }
    const [action, submenu] = menu.menu.items;
    if (action?.type !== "action" || submenu?.type !== "submenu") {
      throw new Error("Expected the direct action and submenu");
    }
    const nested = submenu.items[0];
    if (nested?.type !== "action") throw new Error("Expected the nested action");
    const press = () => {
      button.onPress?.();
      action.onPress?.();
      nested.onPress?.();
    };
    press();
    expect(onPress.mock.calls).toEqual([
      ["button", "first/guide.pdf"],
      ["menu", "first/guide.pdf"],
      ["nested", "first/guide.pdf"],
    ]);
    onPress.mockClear();
    const registrations = harness.setOptionsCalls;
    expect(registrations).toBeGreaterThan(0);

    render("second/guide.pdf");

    expect(harness.setOptionsCalls).toBe(registrations);
    expect(harness.renderedItems).toEqual([button, menu]);
    press();
    expect(onPress.mock.calls).toEqual([
      ["button", "second/guide.pdf"],
      ["menu", "second/guide.pdf"],
      ["nested", "second/guide.pdf"],
    ]);
  },
);

it("applies a custom header element rendered inside a navigation container", () => {
  renderConnecting("Connecting");
  expect(renderedCustomLabel()).toBe("Connecting");

  const applied = harness.setOptionsCalls;
  renderConnecting("Connecting");
  expect(harness.setOptionsCalls).toBe(applied);

  renderConnecting("Reconnecting");
  expect(renderedCustomLabel()).toBe("Reconnecting");
});

it("keeps committed handlers while a replacement render suspends", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  const onPress = vi.fn();
  const pending = new Promise<never>(() => {});
  function Suspend(): never {
    throw pending;
  }
  const toolbar = (value: string, suspend = false) => (
    <Suspense fallback={null}>
      <NativeHeaderToolbar>
        <NativeHeaderToolbar.Button label="Open" onPress={() => onPress(value)} />
      </NativeHeaderToolbar>
      {suspend && <Suspend />}
    </Suspense>
  );
  act(() => root!.render(toolbar("committed")));
  const button = harness.renderedItems[0];
  if (button?.type !== "button") throw new Error("Expected the native button");

  act(() => startTransition(() => root!.render(toolbar("pending", true))));
  button.onPress?.();
  expect(onPress.mock.calls).toEqual([["committed"]]);

  act(() => root!.render(toolbar("replacement")));
  button.onPress?.();
  expect(onPress.mock.calls).toEqual([["committed"], ["replacement"]]);
});

it("isolates toolbar handlers and ignores retained actions after their toolbar unmounts", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  const onPress = vi.fn();
  const toolbar = (id: string, value: string) => (
    <NativeHeaderToolbar key={id}>
      <NativeHeaderToolbar.Button label={id} onPress={() => onPress(id, value)} />
    </NativeHeaderToolbar>
  );
  act(() => root!.render([toolbar("first", "initial")]));
  const first = harness.renderedItems[0];
  if (first?.type !== "button") throw new Error("Expected the first native button");
  act(() => root!.render([toolbar("first", "initial"), toolbar("second", "initial")]));
  const second = harness.renderedItems[0];
  if (second?.type !== "button") throw new Error("Expected the second native button");

  act(() => root!.render([toolbar("first", "updated"), toolbar("second", "updated")]));
  first.onPress?.();
  second.onPress?.();
  expect(onPress.mock.calls).toEqual([
    ["first", "updated"],
    ["second", "updated"],
  ]);

  onPress.mockClear();
  act(() => root!.render([toolbar("second", "remaining")]));
  first.onPress?.();
  second.onPress?.();
  expect(onPress.mock.calls).toEqual([["second", "remaining"]]);

  onPress.mockClear();
  act(() => root!.render(null));
  second.onPress?.();
  expect(onPress).not.toHaveBeenCalled();
});
