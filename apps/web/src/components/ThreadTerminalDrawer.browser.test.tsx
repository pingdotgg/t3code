import { EMPTY_TERMINAL_SESSION_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "starting" | "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  typeIntoSurface: null as ((data: string) => void) | null,
  pressKey: null as ((event: KeyboardEvent) => boolean) | null,
  writes: [] as Array<{ threadId: string; data: string }>,
  resetSessions: () => {},
}));

// Every surface method is a no-op; `then` stays undefined so awaiting the surface resolves to it.
const fakeSurface: object = new Proxy(
  { input: document.createElement("textarea") },
  {
    get: (target, key) =>
      key === "then" ? undefined : key in target ? Reflect.get(target, key) : () => undefined,
  },
);
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: (
      _mount: HTMLElement,
      options: {
        onData: (data: string) => void;
        beforeKey: (event: KeyboardEvent) => boolean;
      },
    ) =>
      new Promise((resolve) => {
        fixture.pendingSurfaces.push(() => {
          fixture.typeIntoSurface = options.onData;
          fixture.pressKey = options.beforeKey;
          resolve(fakeSurface);
        });
      }),
  },
}));
vi.mock("../state/terminalSessions", async () => {
  const Atom = await import("effect/reactivity/Atom");
  // Families cache their atoms, so each test needs fresh ones for its own statuses.
  const makeSessions = () =>
    Atom.family((_environmentId: EnvironmentId) =>
      Atom.family((threadId: ThreadId) =>
        Atom.make({
          ...EMPTY_TERMINAL_SESSION_STATE,
          status: fixture.statusByThreadId.get(threadId) ?? "closed",
          version: 1,
        }),
      ),
    );
  let sessions = makeSessions();
  fixture.resetSessions = () => {
    sessions = makeSessions();
  };
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
  useAtomCommand: () => async (args: { input: { threadId: string; data?: string } }) => {
    if (args.input.data !== undefined) {
      fixture.writes.push({ threadId: args.input.threadId, data: args.input.data });
    }
    return { _tag: "Success" };
  },
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/server", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../state/terminal", () => ({ terminalEnvironment: { write: {}, resize: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("./preview/openTerminalLinkInPreview", () => ({ openTerminalLinkInPreview: () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
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
      onAddTerminalContext={() => {}}
      keybindings={[]}
    />
  );
}

function setup(originalStatus: "starting" | "exited" = "exited") {
  fixture.resetSessions();
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  fixture.statusByThreadId = new Map([
    [original.threadId, originalStatus],
    [other.threadId, "running"],
  ]);
  fixture.pendingSurfaces = [];
  fixture.typeIntoSurface = null;
  fixture.pressKey = null;
  fixture.writes = [];
  return { original, other };
}

it("drops input until the shell runs instead of failing a write for every key", async () => {
  const { original, other } = setup("starting");
  await using screen = await render(<Drawer threadRef={original} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const clearShortcut = () => new KeyboardEvent("keydown", { key: "l", ctrlKey: true });
  fixture.typeIntoSurface?.("early");
  fixture.pressKey?.(clearShortcut());
  await screen.rerender(<Drawer threadRef={other} onCloseTerminal={() => {}} />);
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  fixture.typeIntoSurface?.("ready");
  fixture.pressKey?.(clearShortcut());
  expect(fixture.writes).toEqual([
    { threadId: other.threadId, data: "ready" },
    { threadId: other.threadId, data: "\u000c" },
  ]);
});

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
