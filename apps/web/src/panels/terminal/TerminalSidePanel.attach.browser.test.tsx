import { act, render as renderScreen, stubGlobal, type Screen } from "../../../test/render";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// Drives the registered terminal through the real RegisteredSidePanel ->
// TerminalSidePanel -> ThreadTerminalDrawer -> TerminalViewport path. Only the
// terminal transport (attach, write, resize), the WASM surface and the thread
// read model are stubbed.
const transport = vi.hoisted(() => ({
  attached: [] as unknown[],
  commands: [] as Array<{ command: string; value: unknown }>,
  surfaces: [] as Array<{ onData: (data: string) => void }>,
}));

vi.mock("~/state/terminalSessions", async () => {
  const { EMPTY_TERMINAL_SESSION_STATE: empty } =
    await import("@t3tools/client-runtime/state/terminal");
  return {
    useKnownTerminalSessions: () => [],
    useAttachedTerminalSession: (input: unknown) => {
      transport.attached.push(input);
      return empty;
    },
  };
});
// This client holds every scope, so the terminal accepts typing.
vi.mock("~/state/session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      initialConfigValueAtom: Atom.family(() => Atom.make(null)),
      preparedConnectionValueAtom: Atom.family(() => Atom.make(Option.none())),
      sessionStateAtom: Atom.family(() => Atom.make(AsyncResult.initial())),
    },
    environmentSessionStatesAtom: () => Atom.make([]),
    readPreparedConnection: () => null,
    usePreparedConnection: () => null,

    useEnvironmentScope: () => true,
    readEnvironmentScope: () => true,
  };
});
vi.mock("~/state/terminal", () => ({
  terminalEnvironment: { write: "write", resize: "resize", open: "open" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (value: unknown) => {
    if (typeof command === "string") transport.commands.push({ command, value });
    return { _tag: "Success" };
  },
}));
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: async (_mount: HTMLElement, options: { onData: (data: string) => void }) => {
      transport.surfaces.push(options);
      // Every surface method is a no-op; the test only feeds keystrokes through onData.
      return new Proxy(
        {},
        { get: (_target, key) => (key === "then" ? undefined : () => undefined) },
      );
    },
  },
}));
vi.mock("~/state/entities", () => {
  const project = { workspaceRoot: "/repo" };
  return {
    readEnvironmentSupportsServerBrowser: () => false,
    useEnvironmentSupportsServerBrowser: () => false,
    useQuietThreadShell: (ref: ScopedThreadRef) => ({
      environmentId: ref.environmentId,
      projectId: "project-a",
      worktreePath: null,
    }),
    useProject: () => project,
    readProject: () => project,
  };
});

import type { RightPanelSurface } from "~/rightPanelStore";

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext, type PanelHost } from "../panelHost";

const threadA: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const threadB: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-b"),
  threadId: ThreadId.make("thread-b"),
};
const surface: Extract<RightPanelSurface, { kind: "terminal" }> = {
  id: "terminal:term-1",
  kind: "terminal",
  resourceId: "term-1",
  terminalIds: ["term-1"],
  activeTerminalId: "term-1",
};
const hostFor = (threadRef: ScopedThreadRef): PanelHost => ({
  threadRef,
  visible: true,
  composerDraftTarget: threadRef,
  workspaceMutationId: null,
  sendAnnotation: () => undefined,
});

async function renderTerminal(screen: Screen, threadRef: ScopedThreadRef) {
  await screen.rerender(
    <PanelHostContext value={hostFor(threadRef)}>
      <Suspense fallback={null}>
        <RegisteredSidePanel
          id="terminal"
          surface={surface}
          launchContext={null}
          onAddTerminalContext={() => undefined}
          onSplitTerminal={() => undefined}
          onSplitTerminalVertical={() => undefined}
          onNewTerminal={() => undefined}
          onActiveTerminalChange={() => undefined}
          onCloseTerminal={() => undefined}
        />
      </Suspense>
    </PanelHostContext>,
  );
}

// The registry loads the body lazily; let that import settle before asserting.
async function settle() {
  await act(async () => {
    await import("./TerminalSidePanel");
  });
}

async function type(data: string) {
  await act(async () => transport.surfaces.at(-1)!.onData(data));
}

describe("registered terminal panel", () => {
  it("attaches the host thread's terminal and sends typing to it, then follows a thread switch", async () => {
    resetFixture();
    using _resizeObserver = stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    await using screen = await renderScreen(null, { router: false });
    await renderTerminal(screen, threadA);
    await settle();
    expect(transport.attached.at(-1)).toMatchObject({
      environmentId: threadA.environmentId,
      terminal: { threadId: threadA.threadId, terminalId: "term-1", cwd: "/repo" },
    });
    await type("ls\r");
    expect(transport.commands).toContainEqual({
      command: "write",
      value: {
        environmentId: threadA.environmentId,
        input: { threadId: threadA.threadId, terminalId: "term-1", data: "ls\r" },
      },
    });

    await renderTerminal(screen, threadB);
    await settle();
    expect(transport.attached.at(-1)).toMatchObject({
      environmentId: threadB.environmentId,
      terminal: { threadId: threadB.threadId, terminalId: "term-1", cwd: "/repo" },
    });
    transport.commands = [];
    await type("pwd\r");
    expect(transport.commands.filter((entry) => entry.command === "write")).toEqual([
      {
        command: "write",
        value: {
          environmentId: threadB.environmentId,
          input: { threadId: threadB.threadId, terminalId: "term-1", data: "pwd\r" },
        },
      },
    ]);
  });
});

function resetFixture() {
  transport.attached = [];
  transport.commands = [];
  transport.surfaces = [];
}
