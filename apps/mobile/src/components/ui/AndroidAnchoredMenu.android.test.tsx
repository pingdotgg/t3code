import { act, createContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: {
    readonly children?: ReactNode;
    readonly importantForAccessibility?: string;
    readonly accessibilityElementsHidden?: boolean;
    readonly hitSlop?: number;
  }) => (
    <div
      data-important={props.importantForAccessibility}
      data-hidden={props.accessibilityElementsHidden ? "true" : undefined}
    >
      {props.children}
    </div>
  ),
  Pressable: (props: {
    readonly children?: ReactNode;
    readonly accessibilityRole?: string;
    readonly accessibilityLabel?: string;
    readonly accessibilityState?: { readonly selected?: boolean; readonly disabled?: boolean };
    readonly hitSlop?: number;
  }) => (
    <button
      type="button"
      data-role={props.accessibilityRole}
      data-label={props.accessibilityLabel}
      data-selected={props.accessibilityState?.selected ? "true" : undefined}
      data-hitslop={props.hitSlop !== undefined ? String(props.hitSlop) : undefined}
    >
      {props.children}
    </button>
  ),
  ScrollView: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: () => false,
}));
vi.mock("../../lib/backHandler", () => ({
  useHardwareBack: () => {},
}));
vi.mock("../../native/window-hinge-context", () => ({
  WindowHingeContext: createContext(null),
}));
vi.mock("./OverlayPortal", () => ({
  OverlayPortal: (props: { readonly children?: ReactNode }) => <>{props.children}</>,
}));
vi.mock("./useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1, menuWidth: 200, menuItemHeight: 48 }),
}));
vi.mock("./MenuPopup", () => ({
  MenuPopup: () => null,
}));

import { Pressable, View } from "react-native";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu.android";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

it("lifts trigger accessibility props onto the single outer button and hides inner trigger descendants", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() =>
    root.render(
      <AndroidAnchoredMenu actions={[{ id: "open", title: "Open" }]} title="Fallback">
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Filter by state"
            accessibilityState={{ selected: true }}
          >
            <span>Open</span>
          </Pressable>
        </View>
      </AndroidAnchoredMenu>,
    ),
  );

  const outer = container.firstElementChild as HTMLElement | null;
  expect(outer?.getAttribute("data-role")).toBe("button");
  expect(outer?.getAttribute("data-label")).toBe("Filter by state");
  expect(outer?.getAttribute("data-selected")).toBe("true");
  const innerHidden = outer?.firstElementChild as HTMLElement | null;
  expect(innerHidden?.getAttribute("data-important")).toBe("no-hide-descendants");
  expect(innerHidden?.getAttribute("data-hidden")).toBe("true");
  const innerButton = innerHidden?.querySelector("button");
  expect(innerButton?.getAttribute("data-role")).toBeNull();
  expect(innerButton?.getAttribute("data-label")).toBeNull();
});

it("resolves missing accessibility fields past hitSlop wrappers and across sibling child arrays", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() =>
    root.render(
      <AndroidAnchoredMenu actions={[{ id: "open", title: "Open" }]}>
        <View hitSlop={8}>
          <span>Icon</span>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Filter by state"
            accessibilityState={{ selected: true }}
          >
            <span>Open</span>
          </Pressable>
        </View>
      </AndroidAnchoredMenu>,
    ),
  );

  const outer = container.firstElementChild as HTMLElement | null;
  expect(outer?.getAttribute("data-label")).toBe("Filter by state");
  expect(outer?.getAttribute("data-selected")).toBe("true");
  expect(outer?.getAttribute("data-hitslop")).toBe("8");
  const innerButton = outer?.firstElementChild?.querySelector("button");
  expect(innerButton?.getAttribute("data-role")).toBeNull();
  expect(innerButton?.getAttribute("data-label")).toBeNull();
});
