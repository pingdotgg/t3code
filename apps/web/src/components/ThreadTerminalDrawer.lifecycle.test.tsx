import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const sessions = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn() }));

vi.mock("../hooks/useLocalStorage", () => ({ useLocalStorage: () => [false] }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => "monospace",
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: ({ terminal }: { terminal: { terminalId: string } }) => {
    useEffect(() => {
      sessions.attach(terminal.terminalId);
      return () => sessions.detach(terminal.terminalId);
    }, [terminal.terminalId]);
    return { output: [], error: null, status: "running", version: 0 };
  },
}));
vi.mock("./ui/popover", () => ({
  Popover: "div",
  PopoverPopup: "div",
  PopoverTrigger: "div",
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: "div",
  TooltipPopup: "div",
}));

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the original terminal attached while splitting and returning to one pane", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerHeight: 1000 }));
  const threadId = ThreadId.make("thread-1");
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId };
  const noop = () => {};
  const render = async (terminalIds: string[]) => {
    const drawer = (
      <ThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadId}
        cwd="/fixture"
        height={280}
        terminalIds={terminalIds}
        activeTerminalId="original"
        terminalGroups={[{ id: "group", terminalIds }]}
        activeTerminalGroupId="group"
        focusRequestId={0}
        onSplitTerminal={noop}
        onSplitTerminalVertical={noop}
        onNewTerminal={noop}
        onActiveTerminalChange={noop}
        onCloseTerminal={noop}
        onHeightChange={noop}
        onAddTerminalContext={noop}
        keybindings={[]}
      />
    );
    await act(() => {
      if (renderer) renderer.update(drawer);
      else renderer = create(drawer);
    });
  };

  await render(["original"]);
  await render(["original", "split"]);
  expect(sessions.attach.mock.calls).toEqual([["original"], ["split"]]);
  expect(sessions.detach.mock.calls).toEqual([]);

  await render(["original"]);
  expect(sessions.attach.mock.calls).toEqual([["original"], ["split"]]);
  expect(sessions.detach.mock.calls).toEqual([["split"]]);
});
