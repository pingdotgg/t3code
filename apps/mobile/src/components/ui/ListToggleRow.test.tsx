import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: (props: {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
    readonly onPress: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("./AppText", () => ({ AppText: (props: { children?: ReactNode }) => props.children }));
vi.mock("./ListRowLayout", () => ({
  ListRowLayout: (props: { accessory?: ReactNode }) => props.accessory,
}));
vi.mock("./ThemedSwitch", () => ({ ThemedSwitch: () => null }));

import { ListToggleRow } from "./ListToggleRow";

it("sets a mixed row on, then off when an older environment drops it", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const saves: boolean[] = [];
  try {
    // The older environment dropped the unknown key, so the row stays mixed after every save.
    act(() =>
      root.render(
        <ListToggleRow
          label="Clone into host folders"
          value={null}
          onValueChange={(value) => saves.push(value)}
        />,
      ),
    );
    const button = () => container.querySelector("button")!;

    act(() => button().click());
    const offer = { text: button().textContent, label: button().getAttribute("aria-label") };
    act(() => button().click());

    expect(saves).toEqual([true, false]);
    expect(offer).toEqual({
      text: "Mixed · Set off",
      label: "Set Clone into host folders off for selected environments",
    });
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
