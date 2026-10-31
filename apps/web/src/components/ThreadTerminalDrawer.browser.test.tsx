import { EMPTY_TERMINAL_SESSION_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import type { TerminalContextSelection } from "../lib/terminalContext";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  contextMenu: undefined as ((event: MouseEvent) => void) | undefined,
  showContextMenu: vi.fn(),
  selection: "",
  clearSelection: vi.fn(),
}));

// Every surface method is a no-op; `then` stays undefined so awaiting the surface resolves to it.
const fakeSurface: object = new Proxy(
  {
    input: document.createElement("textarea"),
    hasSelection: () => fixture.selection.length > 0,
    getSelection: () => fixture.selection,
    getSelectionPosition: () => ({ start: { y: 0 }, end: { y: 1 } }),
    getSelectionEndClientRect: () => null,
    clearSelection: () => {
      fixture.clearSelection();
      fixture.selection = "";
    },
  },
  {
    get: (target, key) =>
      key === "then" ? undefined : key in target ? Reflect.get(target, key) : () => undefined,
  },
);
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: (_mount: HTMLElement, options: { onContextMenu: (event: MouseEvent) => void }) =>
      new Promise((resolve) => {
        fixture.contextMenu = options.onContextMenu;
        fixture.pendingSurfaces.push(() => resolve(fakeSurface));
      }),
  },
}));
vi.mock("../state/terminalSessions", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const sessions = Atom.family((_environmentId: EnvironmentId) =>
    Atom.family((threadId: ThreadId) =>
      Atom.make({
        ...EMPTY_TERMINAL_SESSION_STATE,
        status: fixture.statusByThreadId.get(threadId) ?? "closed",
        version: 1,
      }),
    ),
  );
  return {
    attachedTerminalSessionAtom: (environmentId: EnvironmentId, terminal: { threadId: ThreadId }) =>
      sessions(environmentId)(terminal.threadId),
  };
});
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/server", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../state/terminal", () => ({ terminalEnvironment: { write: {}, resize: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../layout/PaneTabs", () => ({
  LayoutPaneTab: () => null,
  LayoutPaneTabStrip: ({ children }: { children: React.ReactNode }) => children,
  useLayoutPaneSiblingTabs: () => ({ before: [], after: [] }),
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("./preview/openTerminalLinkInPreview", () => ({ openTerminalLinkInPreview: () => {} }));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: fixture.showContextMenu } }),
}));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select(DEFAULT_CLIENT_SETTINGS),
  };
});

function Drawer(props: {
  threadRef: ScopedThreadRef;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
  onAddTerminalContext?: (selection: TerminalContextSelection) => Promise<boolean>;
}) {
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd="/repo"
      height={240}
      terminalIds={["term-1"]}
      activeTerminalId="term-1"
      terminalGroups={[{ id: "group-1", terminalIds: ["term-1"] }]}
      activeTerminalGroupId="group-1"
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={props.onCloseTerminal}
      onHeightChange={() => {}}
      onAddTerminalContext={props.onAddTerminalContext}
      keybindings={[]}
    />
  );
}

function setup() {
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  fixture.statusByThreadId = new Map([
    [original.threadId, "exited"],
    [other.threadId, "running"],
  ]);
  fixture.pendingSurfaces = [];
  fixture.contextMenu = undefined;
  fixture.showContextMenu.mockReset().mockResolvedValue("add-to-chat");
  fixture.selection = "selected output";
  fixture.clearSelection.mockReset();
  return { original, other };
}

it("closes an exited terminal on its own thread after navigating to one reusing its ID", async () => {
  const { original, other } = setup();
  const onCloseTerminal = vi.fn();
  await using screen = await render(
    <Drawer threadRef={original} onCloseTerminal={onCloseTerminal} />,
  );
  using _timers = fakeTimers();
  // The exit is seen once the surface loads, and its close waits for the next task.
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await screen.rerender(<Drawer threadRef={other} onCloseTerminal={onCloseTerminal} />);
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(onCloseTerminal.mock.calls).toEqual([["term-1", original]]);
});

it.each([false, true])("clears selected output only after chat accepts it: %s", async (added) => {
  const { other } = setup();
  let accept: (added: boolean) => void = () => {};
  const onAddTerminalContext = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      }),
  );
  await using _screen = await render(
    <Drawer
      threadRef={other}
      onCloseTerminal={() => {}}
      onAddTerminalContext={onAddTerminalContext}
    />,
  );
  await act(() => fixture.pendingSurfaces.shift()?.());
  await act(() => fixture.contextMenu?.(new MouseEvent("contextmenu", { cancelable: true })));
  expect(onAddTerminalContext).toHaveBeenCalledWith(
    expect.objectContaining({ text: "selected output" }),
  );
  expect(fixture.clearSelection).not.toHaveBeenCalled();
  await act(() => accept(added));
  expect(fixture.clearSelection).toHaveBeenCalledTimes(added ? 1 : 0);
});

it("omits add to chat when the terminal has no composer target", async () => {
  const { other } = setup();
  await using _screen = await render(<Drawer threadRef={other} onCloseTerminal={() => {}} />);
  await act(() => fixture.pendingSurfaces.shift()?.());
  await act(() => fixture.contextMenu?.(new MouseEvent("contextmenu", { cancelable: true })));
  const items = fixture.showContextMenu.mock.calls[0]![0];
  expect(items).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "add-to-chat" })]),
  );
  expect(fixture.clearSelection).not.toHaveBeenCalled();
});
