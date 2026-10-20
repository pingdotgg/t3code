import {
  AuthTerminalOperateScope,
  EnvironmentId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { nextTerminalAttachSeedState } from "@t3tools/client-runtime/state/terminal";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import type {
  GhosttyTerminalSurface,
  GhosttyTerminalSurfaceOptions,
} from "~/terminal/ghostty/surface";

const state = vi.hoisted(() => ({
  allowed: true,
  listeners: new Set<() => void>(),
  resize: vi.fn(),
  otherCommand: vi.fn(),
  createSurface:
    vi.fn<
      (
        mount: HTMLElement,
        options: GhosttyTerminalSurfaceOptions,
      ) => Promise<GhosttyTerminalSurface>
    >(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => null) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useClientSettings: ((select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    select(DEFAULT_CLIENT_SETTINGS)) as never,
}));
vi.mock(import("../editorPreferences"), async (original) => ({
  ...(await original()),
  useOpenInPreferredEditor: (() => state.otherCommand) as never,
}));
vi.mock(import("../state/terminal"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    terminalEnvironment: { ...actual.terminalEnvironment, resize: "resize" as never },
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "resize" ? state.resize : state.otherCommand) as never,
}));
vi.mock(import("../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useAttachedTerminalSession: (() => session) as never,
}));
vi.mock(import("~/terminal/ghostty/surface"), async (original) => ({
  ...(await original()),
  GhosttyTerminalSurface: { create: state.createSurface } as never,
}));
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthTerminalOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readEnvironmentScope,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});

import { act, render } from "../../test/render";
import ThreadTerminalDrawer, { TerminalViewport } from "./ThreadTerminalDrawer";

const threadRef = {
  environmentId: EnvironmentId.make("secondary-terminal"),
  threadId: ThreadId.make("thread"),
};
const session = { ...nextTerminalAttachSeedState(), status: "running" as const, version: 1 };
// The mocked modules read `state`, so every test starts by resetting all of it.
function setup() {
  state.allowed = true;
  state.listeners.clear();
  state.resize.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.otherCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  // A surface can report its initial grid while asynchronous WASM setup is
  // pending. Keep that unrelated setup pending while exercising its callback.
  state.createSurface.mockReset().mockReturnValue(new Promise(() => undefined));
}

it("rechecks the target terminal grant when a retained surface callback reports a resize", async () => {
  setup();
  await using _screen = await render(
    <TerminalViewport
      advancedTypography={false}
      threadRef={threadRef}
      threadId={threadRef.threadId}
      terminalId="terminal-1"
      terminalLabel="Terminal 1"
      cwd="/repo"
      onSessionExited={state.otherCommand}
      focusRequestId={0}
      autoFocus={false}
      visible={true}
      resizeEpoch={0}
      drawerHeight={200}
      keybindings={[]}
    />,
  );
  expect(state.createSurface).toHaveBeenCalledOnce();
  const onResize = state.createSurface.mock.calls[0]![1].onResize;
  if (!onResize) throw new Error("The terminal did not register its resize callback.");

  onResize(80, 24);
  expect(state.resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, terminalId: "terminal-1", cols: 80, rows: 24 },
  });

  state.allowed = false;
  onResize(120, 40);
  expect(state.resize).toHaveBeenCalledTimes(1);

  state.allowed = true;
  onResize(100, 30);
  expect(state.resize).toHaveBeenCalledTimes(2);
  expect(state.resize).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, terminalId: "terminal-1", cols: 100, rows: 30 },
  });
});

it("keeps held Kitty keys and the original surface through split, focus, and unsplit", async () => {
  setup();
  const { GhosttyTerminalSurface } = await vi.importActual<
    typeof import("~/terminal/ghostty/surface")
  >("~/terminal/ghostty/surface");
  const output: string[][] = [];
  state.createSurface.mockImplementation((mount, options) => {
    const data: string[] = [];
    output.push(data);
    return GhosttyTerminalSurface.create(mount, {
      ...options,
      onData: (chunk) => {
        data.push(chunk);
        options.onData(chunk);
      },
    });
  });
  const consumeShortcut = (event: KeyboardEvent) => {
    if ((event.code === "KeyD" && event.ctrlKey) || (event.code === "KeyB" && event.repeat)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  // ChatView installs its capture listener before the terminal mounts.
  window.addEventListener("keydown", consumeShortcut, { capture: true });
  using _shortcut = {
    [Symbol.dispose]: () =>
      window.removeEventListener("keydown", consumeShortcut, { capture: true }),
  };
  const composer = document.createElement("textarea");
  document.body.append(composer);
  using _composer = { [Symbol.dispose]: () => composer.remove() };
  const drawer = (terminalIds: string[]) => (
    <ThreadTerminalDrawer
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd="/repo"
      height={280}
      terminalIds={terminalIds}
      activeTerminalId="original"
      terminalGroups={[{ id: "group", terminalIds }]}
      activeTerminalGroupId="group"
      focusRequestId={0}
      onSplitTerminal={state.otherCommand}
      onSplitTerminalVertical={state.otherCommand}
      onNewTerminal={state.otherCommand}
      onActiveTerminalChange={state.otherCommand}
      onCloseTerminal={state.otherCommand}
      onHeightChange={state.otherCommand}
      onAddTerminalContext={state.otherCommand}
      keybindings={[]}
    />
  );
  const surfacesCreated = () =>
    act(async () => {
      await Promise.all(state.createSurface.mock.results.map((result) => result.value));
    });
  await using screen = await render(drawer(["original"]));
  const { container } = screen;
  await surfacesCreated();
  const original = await state.createSurface.mock.results[0]!.value;
  const disposeOriginal = vi.spyOn(original, "dispose");
  original.write("\x1b[>11u");
  const key = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
    original.input.dispatchEvent(
      new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  original.focus();
  key("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
  key("keydown", { key: "d", code: "KeyD", ctrlKey: true });
  await screen.rerender(drawer(["original", "split"]));
  await surfacesCreated();
  expect(state.createSurface).toHaveBeenCalledTimes(2);
  expect(container.querySelector("textarea")).toBe(original.input);
  expect(disposeOriginal).not.toHaveBeenCalled();
  const split = await state.createSurface.mock.results[1]!.value;
  const disposeSplit = vi.spyOn(split, "dispose");
  original.focus();
  key("keyup", { key: "d", code: "KeyD", ctrlKey: true });
  key("keyup", { key: "Control", code: "ControlLeft" });

  key("keydown", { key: "b", code: "KeyB" });
  composer.focus();
  original.focus();
  key("keydown", { key: "b", code: "KeyB", repeat: true });
  key("keyup", { key: "b", code: "KeyB" });

  key("keydown", { key: "c", code: "KeyC" });
  await screen.rerender(drawer(["original"]));
  await surfacesCreated();
  expect(state.createSurface).toHaveBeenCalledTimes(2);
  expect(container.querySelector("textarea")).toBe(original.input);
  expect(disposeOriginal).not.toHaveBeenCalled();
  expect(disposeSplit).toHaveBeenCalledOnce();
  original.focus();
  key("keyup", { key: "c", code: "KeyC" });
  expect(output).toEqual([
    ["\x1b[57442;5u", "\x1b[57442;1:3u", "\x1b[98u", "\x1b[98;1:3u", "\x1b[99u", "\x1b[99;1:3u"],
    [],
  ]);
});
