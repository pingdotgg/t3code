import {
  AuthTerminalOperateScope,
  EnvironmentId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { nextTerminalAttachSeedState } from "@t3tools/client-runtime/state/terminal";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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

import { TerminalViewport } from "./ThreadTerminalDrawer";

const threadRef = {
  environmentId: EnvironmentId.make("secondary-terminal"),
  threadId: ThreadId.make("thread"),
};
const session = { ...nextTerminalAttachSeedState(), status: "running" as const, version: 1 };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  state.allowed = true;
  state.listeners.clear();
  state.resize.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.otherCommand.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  // A surface can report its initial grid while asynchronous WASM setup is
  // pending. Keep that unrelated setup pending while exercising its callback.
  state.createSurface.mockReset().mockReturnValue(new Promise(() => undefined));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("rechecks the target terminal grant when a retained surface callback reports a resize", async () => {
  await act(async () =>
    root.render(
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
    ),
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
