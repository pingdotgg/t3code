import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { HardwareKeyboardCommandProvider } from "./HardwareKeyboardCommandProvider";
import type { HardwareKeyboardCommand } from "./hardwareKeyboardCommands";

const navigation = { canGoBack: () => true, navigate: vi.fn() };
let nativeCommands: {
  readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
  readonly onCommand: (command: HardwareKeyboardCommand) => void;
} | null = null;

vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  useNavigation: () => navigation,
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../../lib/copyThreadReference", () => ({ copyThreadReference: vi.fn() }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  firstWorkspaceDetailOpen: () => false,
  workspaceHasColumns: () => false,
}));
vi.mock("../layout/workspace/workspace-detail-selection", () => ({
  selectWorkspaceDetail: vi.fn(),
}));
vi.mock("../threads/GitActionProgressOverlay", () => ({ GitActionProgressOverlay: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../../native/T3KeyboardCommands", () => ({
  T3KeyboardCommands: (props: {
    readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
    readonly onCommand: (command: HardwareKeyboardCommand) => void;
    readonly children: React.ReactNode;
  }) => {
    nativeCommands = props;
    return props.children;
  },
}));

it("keeps a terminal opened with a session id as the current terminal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <HardwareKeyboardCommandProvider pathname="/threads/env/thread-17/terminal?terminalId=term-2">
        {null}
      </HardwareKeyboardCommandProvider>,
    ),
  );

  expect(nativeCommands?.enabledCommands).toContain("terminal");
  expect(nativeCommands?.enabledCommands).not.toContain("copyThreadReference");
  act(() => nativeCommands?.onCommand("terminal"));
  expect(navigation.navigate).not.toHaveBeenCalled();
  act(() => root.unmount());
});
