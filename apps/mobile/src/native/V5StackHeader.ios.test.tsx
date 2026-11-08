import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { StackHeaderConfigProps } from "react-native-screens";
import { expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => ({ ios: undefined as StackHeaderConfigProps["ios"] }));

vi.mock("react-native", () => ({ StyleSheet: { flatten: (style: unknown) => style } }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: vi.fn() },
  useKeyboardState: () => false,
}));
vi.mock("../lib/useMobileNavigationTheme", () => ({
  useMobileNavigationTheme: () => ({ colors: { card: "white" } }),
}));
vi.mock("./native-layout-metrics", () => ({
  useDeviceType: () => "phone",
  useNativeLayoutMetrics: () => null,
}));
vi.mock("react-native-screens", () => ({
  Stack: {
    HeaderConfig: ({ ios }: StackHeaderConfigProps) => {
      bridge.ios = ios;
      return null;
    },
  },
}));

import { V5StackHeader } from "./V5StackHeader.ios";

it("attaches a title long-press menu to the native header config", () => {
  bridge.ios = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    act(() =>
      root.render(
        <V5StackHeader
          canGoBack={false}
          options={{
            title: "Start a Conversation",
            unstable_headerTitleMenu: () => ({
              title: "Thread actions",
              items: [
                {
                  type: "action",
                  label: "Settle thread",
                  icon: { type: "sfSymbol", name: "checkmark" },
                  onPress: () => {},
                },
                {
                  type: "submenu",
                  label: "Snooze",
                  icon: { type: "sfSymbol", name: "clock" },
                  items: [{ type: "action", label: "1 hour", onPress: () => {} }],
                },
              ],
            }),
          }}
        />,
      ),
    );
    expect(bridge.ios?.titleMenu).toMatchObject({
      type: "menu",
      title: "Thread actions",
    });
    expect(bridge.ios?.titleMenu?.children).toEqual([
      expect.objectContaining({
        type: "menuItem",
        title: "Settle thread",
        icon: { type: "sfSymbol", name: "checkmark" },
      }),
      expect.objectContaining({
        type: "menu",
        title: "Snooze",
        icon: { type: "sfSymbol", name: "clock" },
      }),
    ]);
    expect(bridge.ios?.trailingItems ?? []).toEqual([]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("forwards submenu icons into the native menu tree", () => {
  bridge.ios = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    act(() =>
      root.render(
        <V5StackHeader
          canGoBack={false}
          options={{
            unstable_headerRightItems: () => [
              {
                type: "menu",
                label: "Thread actions",
                icon: { type: "sfSymbol", name: "ellipsis" },
                menu: {
                  items: [
                    {
                      type: "action",
                      label: "Settle thread",
                      icon: { type: "sfSymbol", name: "checkmark" },
                      onPress: () => {},
                    },
                    {
                      type: "submenu",
                      label: "Snooze",
                      icon: { type: "sfSymbol", name: "clock" },
                      items: [
                        {
                          type: "action",
                          label: "1 hour",
                          onPress: () => {},
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          }}
        />,
      ),
    );
    const [menuItem] = (bridge.ios as StackHeaderConfigProps["ios"])?.trailingItems ?? [];
    if (menuItem?.type !== "item" || !("menu" in menuItem) || !menuItem.menu) {
      throw new Error("Expected a trailing menu item");
    }
    const [settle, snooze] = menuItem.menu.children;
    expect(settle).toMatchObject({
      type: "menuItem",
      title: "Settle thread",
      icon: { type: "sfSymbol", name: "checkmark" },
    });
    expect(snooze).toMatchObject({
      type: "menu",
      title: "Snooze",
      icon: { type: "sfSymbol", name: "clock" },
    });
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["leadingItems", "trailingItems", "toolbarItems"] as const)(
  "updates native enabled state after permissions change in %s",
  (placement) => {
    bridge.ios = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    const onPress = () => {};
    try {
      for (const disabled of [true, false, undefined, true]) {
        const items: NativeStackHeaderItem[] = [
          { type: "button", label: "Files", disabled, onPress },
          {
            type: "menu",
            label: "Terminal",
            disabled,
            menu: { items: [{ type: "action", label: "Open terminal", onPress }] },
          },
        ];
        act(() =>
          root.render(
            <V5StackHeader
              canGoBack={false}
              options={{
                unstable_headerLeftItems: () => (placement === "leadingItems" ? items : []),
                unstable_headerRightItems: () => (placement === "trailingItems" ? items : []),
                unstable_headerToolbarItems: () => (placement === "toolbarItems" ? items : []),
              }}
            />,
          ),
        );
        const nativeItems = (bridge.ios as StackHeaderConfigProps["ios"])?.[placement];
        expect(nativeItems).toHaveLength(2);
        for (const item of nativeItems ?? []) {
          if (item.type !== "item" || "render" in item)
            throw new Error("Expected a native bar item");
          // RNSHeaderContentFactory sets UIBarButtonItem.enabled to !item.disabled.
          expect(!item.disabled).toBe(!disabled);
        }
      }
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
