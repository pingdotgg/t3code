import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { HardwareKeyboardCommandProvider } from "./HardwareKeyboardCommandProvider";
import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

const enabledCommandsSeen: ReadonlyArray<HardwareKeyboardCommand>[] = [];
const navigation = { canGoBack: () => false };

vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  useNavigation: () => navigation,
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../../lib/copyThreadReference", () => ({ copyThreadReference: vi.fn() }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../workspace/workspace-selection-store", () => ({
  firstWorkspaceDetailOpen: () => false,
  workspaceHasColumns: () => false,
}));
vi.mock("../workspace/workspace-detail-selection", () => ({ selectWorkspaceDetail: vi.fn() }));
vi.mock("../threads/GitActionProgressOverlay", () => ({ GitActionProgressOverlay: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../../native/T3KeyboardCommands", () => ({
  T3KeyboardCommands: (props: {
    readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
    readonly children: React.ReactNode;
  }) => {
    enabledCommandsSeen.push(props.enabledCommands);
    return props.children;
  },
}));

const focusSearch = () => {};

function SearchScreen() {
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  return null;
}

it("enables commands that screens register after the provider renders", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <HardwareKeyboardCommandProvider pathname="/">
        <SearchScreen />
      </HardwareKeyboardCommandProvider>,
    ),
  );

  expect(enabledCommandsSeen.at(-1)).toContain("focusSearch");
  act(() => root.unmount());
});
