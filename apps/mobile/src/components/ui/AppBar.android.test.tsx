import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Keyboard: { dismiss: () => {} },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
const useIsFocusedMock = vi.fn<() => boolean>(() => {
  throw new Error("Couldn't find a navigation object.");
});
// React Navigation throws this outside a navigator, as for the Arrange threads sheet.
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => useIsFocusedMock(),
}));
vi.mock("./AndroidScreenHeader.android", () => ({
  AndroidScreenHeader: (props: { readonly title: string }) => <h1>{props.title}</h1>,
}));
vi.mock("./WorkspaceAppBar.android", () => ({
  useHasWorkspaceAppBar: () => false,
  WorkspaceAppBar: () => null,
}));
vi.mock("./AndroidAnchoredMenu.android", () => ({
  AndroidAnchoredMenu: (props: {
    readonly children?: ReactNode | ((open: () => void) => ReactNode);
  }) => (typeof props.children === "function" ? props.children(() => {}) : props.children),
}));
vi.mock("./ScreenHeaderButton.android", () => ({ ScreenHeaderButton: () => null }));
vi.mock("./SearchField", () => ({ SearchField: () => null }));
vi.mock("./Button", () => ({ Button: () => null }));
vi.mock("../../features/layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 48, paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../features/layout/useSidebarToggle", () => ({ useSidebarToggle: () => null }));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { AppBar } from "./AppBar.android";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

it("renders a sheet bar without search outside a navigation container", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(<AppBar sheet title="Arrange threads" />));

  expect(container.textContent).toBe("Arrange threads");
});

it("does not mount the hidden screen header while inline search is active", () => {
  useIsFocusedMock.mockReturnValueOnce(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() =>
    root.render(
      <AppBar
        title="Archived threads"
        search={{
          mode: "inline",
          value: "",
          placeholder: "Search",
          onChangeText: () => {},
        }}
      />,
    ),
  );

  expect(container.querySelector("h1")).toBeNull();
});
