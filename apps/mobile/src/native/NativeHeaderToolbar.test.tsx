import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { act, createContext, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  params: { path: ["first", "guide.pdf"] },
  renderedItems: [] as NativeStackHeaderItem[],
  setOptionsCalls: 0,
  openedDocuments: [] as string[],
}));

// Native headers retain the actions materialized when navigation applies options.
vi.mock("@react-navigation/native", () => {
  const navigation = {
    setOptions(options: {
      unstable_headerLeftItems?: () => NativeStackHeaderItem[];
      unstable_headerRightItems?: () => NativeStackHeaderItem[];
      unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
    }) {
      harness.setOptionsCalls += 1;
      harness.renderedItems =
        options.unstable_headerLeftItems?.() ??
        options.unstable_headerRightItems?.() ??
        options.unstable_headerToolbarItems?.() ??
        [];
    },
  };
  return {
    useNavigation: () => navigation,
    useRoute: () => ({ key: "file", name: "ThreadFile", params: harness.params }),
  };
});

import { NativeHeaderToolbar } from "./NativeHeaderToolbar";

let root: Root | null = null;
type Placement = "left" | "right" | "bottom";

function DocumentToolbar(props: { readonly path: string; readonly placement: Placement }) {
  return (
    <NativeHeaderToolbar placement={props.placement}>
      <NativeHeaderToolbar.Menu title="File actions" icon="ellipsis">
        <NativeHeaderToolbar.MenuAction onPress={() => harness.openedDocuments.push(props.path)}>
          Open PDF
        </NativeHeaderToolbar.MenuAction>
      </NativeHeaderToolbar.Menu>
    </NativeHeaderToolbar>
  );
}

function renderDocument(path: string, placement: Placement) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.params = { path: path.split("/") };
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(<DocumentToolbar path={path} placement={placement} />));
}

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

function openRenderedDocument() {
  const menu = harness.renderedItems[0];
  if (menu?.type !== "menu") throw new Error("Expected the native file menu");
  const action = menu.menu.items[0];
  if (action?.type !== "action") throw new Error("Expected the native Open PDF action");
  action.onPress?.();
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.renderedItems = [];
  harness.setOptionsCalls = 0;
  harness.openedDocuments = [];
  vi.unstubAllGlobals();
});

it.each(["left", "right", "bottom"] as const)(
  "updates the %s header action when switching between documents with the same name",
  (placement) => {
    renderDocument("first/guide.pdf", placement);
    openRenderedDocument();
    renderDocument("second/guide.pdf", placement);
    openRenderedDocument();

    expect(harness.openedDocuments).toEqual(["first/guide.pdf", "second/guide.pdf"]);
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
