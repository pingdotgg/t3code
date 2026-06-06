import "../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  terminalConstructorSpy,
  terminalDisposeSpy,
  terminalInstances,
  terminalLineTextByRow,
  terminalWriteSpy,
  fitAddonFitSpy,
  fitAddonLoadSpy,
  environmentApiById,
  readEnvironmentApiMock,
  readLocalApiMock,
} = vi.hoisted(() => ({
  terminalConstructorSpy: vi.fn(),
  terminalDisposeSpy: vi.fn(),
  terminalInstances: [] as Array<{
    clearSelection: ReturnType<typeof vi.fn>;
    scrollLines: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    emitData: (data: string) => void;
    writes: string[];
  }>,
  terminalLineTextByRow: new Map<number, string>(),
  terminalWriteSpy: vi.fn(),
  fitAddonFitSpy: vi.fn(),
  fitAddonLoadSpy: vi.fn(),
  environmentApiById: new Map<
    string,
    {
      terminal: {
        open: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
        restart: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      };
    }
  >(),
  readEnvironmentApiMock: vi.fn((environmentId: string) => environmentApiById.get(environmentId)),
  readLocalApiMock: vi.fn<
    () =>
      | {
          contextMenu: { show: ReturnType<typeof vi.fn> };
          shell: { openExternal: ReturnType<typeof vi.fn> };
        }
      | undefined
  >(() => ({
    contextMenu: { show: vi.fn(async () => null) },
    shell: { openExternal: vi.fn(async () => undefined) },
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = fitAddonFitSpy;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: unknown; wordSeparator?: string } = {};
    private selection: { column: number; length: number; row: number } | null = null;
    private selectionText = "";
    private dataListeners = new Set<(data: string) => void>();
    writes: string[] = [];
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn((row: number) => {
          const text = terminalLineTextByRow.get(row);
          return text === undefined
            ? null
            : {
                translateToString: vi.fn(() => text),
              };
        }),
      },
    };

    constructor(options: unknown) {
      terminalConstructorSpy(options);
      terminalInstances.push(this);
    }

    loadAddon(addon: unknown) {
      fitAddonLoadSpy(addon);
    }

    open() {}

    write(data: string) {
      this.writes.push(data);
      terminalWriteSpy(data);
    }

    clear() {}

    clearSelection = vi.fn(() => {
      this.selection = null;
      this.selectionText = "";
    });

    selectLines() {}

    select = vi.fn((column: number, row: number, length: number) => {
      this.selection = { column, length, row };
      const lineText = terminalLineTextByRow.get(row) ?? "";
      this.selectionText =
        lineText.slice(column, Math.min(lineText.length, column + length)) || "selected text";
    });

    focus() {}

    refresh() {}

    scrollLines = vi.fn();

    scrollToBottom() {}

    hasSelection() {
      return this.selection !== null;
    }

    getSelection() {
      return this.selectionText;
    }

    getSelectionPosition() {
      if (!this.selection) return null;
      return {
        end: {
          x: this.selection.column + this.selection.length,
          y: this.selection.row,
        },
        start: {
          x: this.selection.column,
          y: this.selection.row,
        },
      };
    }

    attachCustomKeyEventHandler() {
      return true;
    }

    registerLinkProvider() {
      return { dispose: vi.fn() };
    }

    onData(callback: (data: string) => void) {
      this.dataListeners.add(callback);
      return {
        dispose: vi.fn(() => {
          this.dataListeners.delete(callback);
        }),
      };
    }

    onSelectionChange() {
      return { dispose: vi.fn() };
    }

    dispose() {
      terminalDisposeSpy();
    }

    emitData(data: string) {
      for (const listener of this.dataListeners) {
        listener(data);
      }
    }
  },
}));

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: vi.fn((environmentId: string) => {
    const api = readEnvironmentApiMock(environmentId);
    if (!api) {
      throw new Error(`Environment API not found for environment ${environmentId}`);
    }
    return api;
  }),
  readEnvironmentApi: readEnvironmentApiMock,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import ThreadTerminalDrawer, {
  TERMINAL_WORD_SEPARATORS,
  TerminalViewport,
} from "./ThreadTerminalDrawer";
import { useTerminalStateStore } from "../terminalStateStore";

const THREAD_ID = ThreadId.make("thread-terminal-browser");

function createTerminalSnapshot(
  overrides: Partial<{
    threadId: typeof THREAD_ID;
    terminalId: string;
    cwd: string;
    worktreePath: string | null;
    status: "running";
    pid: number;
    history: string;
    exitCode: number | null;
    exitSignal: number | null;
    updatedAt: string;
  }> = {},
) {
  return {
    threadId: THREAD_ID,
    terminalId: "default",
    cwd: "/repo/project",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...overrides,
  };
}

function createEnvironmentApi() {
  return {
    terminal: {
      open: vi.fn(async () => createTerminalSnapshot()),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      restart: vi.fn(async () =>
        createTerminalSnapshot({
          pid: 456,
          updatedAt: "2026-04-07T00:00:01.000Z",
        }),
      ),
    },
  };
}

async function mountTerminalViewport(props: {
  threadRef: ReturnType<typeof scopeThreadRef>;
  drawerBackgroundColor?: string;
  drawerTextColor?: string;
  resyncRequestId?: number;
  restartRequestId?: number;
}) {
  let currentProps = {
    resyncRequestId: props.resyncRequestId ?? 0,
    restartRequestId: props.restartRequestId ?? 0,
    threadRef: props.threadRef,
  };
  const drawer = document.createElement("div");
  drawer.className = "thread-terminal-drawer";
  if (props.drawerBackgroundColor) {
    drawer.style.backgroundColor = props.drawerBackgroundColor;
  }
  if (props.drawerTextColor) {
    drawer.style.color = props.drawerTextColor;
  }

  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "400px";
  drawer.append(host);
  document.body.append(drawer);

  const screen = await render(
    <TerminalViewport
      threadRef={props.threadRef}
      threadId={THREAD_ID}
      terminalId="default"
      terminalLabel="Terminal"
      cwd="/repo/project"
      onSessionExited={() => undefined}
      onAddTerminalContext={() => undefined}
      focusRequestId={0}
      autoFocus={false}
      resizeEpoch={0}
      resyncRequestId={currentProps.resyncRequestId}
      restartRequestId={currentProps.restartRequestId}
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: host },
  );

  return {
    rerender: async (
      nextProps: Partial<{
        threadRef: ReturnType<typeof scopeThreadRef>;
        resyncRequestId: number;
        restartRequestId: number;
      }>,
    ) => {
      currentProps = { ...currentProps, ...nextProps };
      await screen.rerender(
        <TerminalViewport
          threadRef={currentProps.threadRef}
          threadId={THREAD_ID}
          terminalId="default"
          terminalLabel="Terminal"
          cwd="/repo/project"
          onSessionExited={() => undefined}
          onAddTerminalContext={() => undefined}
          focusRequestId={0}
          autoFocus={false}
          resizeEpoch={0}
          resyncRequestId={currentProps.resyncRequestId}
          restartRequestId={currentProps.restartRequestId}
          drawerHeight={320}
          keybindings={[]}
        />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      drawer.remove();
    },
  };
}

async function mountThreadTerminalDrawer(props: { threadRef: ReturnType<typeof scopeThreadRef> }) {
  const host = document.createElement("div");
  host.style.width = "900px";
  host.style.height = "420px";
  document.body.append(host);

  const screen = await render(
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={THREAD_ID}
      cwd="/repo/project"
      visible
      height={320}
      terminalIds={["default"]}
      activeTerminalId="default"
      terminalGroups={[]}
      activeTerminalGroupId="group-default"
      focusRequestId={0}
      onSplitTerminal={() => undefined}
      onNewTerminal={() => undefined}
      onActiveTerminalChange={() => undefined}
      onCloseTerminal={() => undefined}
      onHeightChange={() => undefined}
      onAddTerminalContext={() => undefined}
      keybindings={[]}
    />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function terminalSurfaceRect(): DOMRect {
  return {
    bottom: 400,
    height: 400,
    left: 0,
    right: 800,
    top: 0,
    width: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

function getTerminalSurface(): HTMLElement {
  const surface = document.querySelector<HTMLElement>("[data-mobile-edge-swipe-block='true']");
  expect(surface).not.toBeNull();
  Object.defineProperty(surface, "getBoundingClientRect", {
    configurable: true,
    value: terminalSurfaceRect,
  });
  Object.defineProperty(surface, "clientHeight", {
    configurable: true,
    value: 400,
  });
  return surface!;
}

function createTouch(target: EventTarget, identifier: number, clientX: number, clientY: number) {
  return new Touch({ clientX, clientY, identifier, target });
}

function dispatchTouchEvent(
  target: EventTarget,
  type: "touchcancel" | "touchend" | "touchmove" | "touchstart",
  touches: Touch[],
  changedTouches: Touch[],
) {
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      changedTouches,
      touches,
    }),
  );
}

describe("TerminalViewport", () => {
  afterEach(() => {
    vi.useRealTimers();
    environmentApiById.clear();
    terminalInstances.length = 0;
    terminalLineTextByRow.clear();
    readEnvironmentApiMock.mockClear();
    readLocalApiMock.mockClear();
    useTerminalStateStore.setState({
      nextTerminalEventId: 1,
      terminalEventEntriesByKey: {},
      terminalLaunchContextByThreadKey: {},
      terminalStateByThreadKey: {},
    });
    terminalConstructorSpy.mockClear();
    terminalDisposeSpy.mockClear();
    terminalWriteSpy.mockClear();
    fitAddonFitSpy.mockClear();
    fitAddonLoadSpy.mockClear();
  });

  it("does not create a terminal when APIs are unavailable", async () => {
    readEnvironmentApiMock.mockReturnValueOnce(undefined);
    readLocalApiMock.mockReturnValueOnce(undefined);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).not.toHaveBeenCalled();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("reopens the terminal when the scoped thread reference changes", async () => {
    const environmentA = createEnvironmentApi();
    const environmentB = createEnvironmentApi();
    environmentApiById.set("environment-a", environmentA);
    environmentApiById.set("environment-b", environmentB);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environmentA.terminal.open).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-b" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environmentB.terminal.open).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reopen the terminal when the scoped thread reference values stay the same", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("retries a terminal open interrupted by websocket reconnect without writing the transient error", async () => {
    vi.useFakeTimers();
    const environment = createEnvironmentApi();
    environment.terminal.open.mockRejectedValueOnce(
      new Error("All fibers interrupted without error"),
    );
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      expect(
        terminalWriteSpy.mock.calls.some((call) =>
          String(call[0]).includes("All fibers interrupted without error"),
        ),
      ).toBe(false);

      await vi.advanceTimersByTimeAsync(250);

      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(2);
      });
      expect(environment.terminal.resize).toHaveBeenCalledWith(
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
      expect(
        terminalWriteSpy.mock.calls.some((call) =>
          String(call[0]).includes("All fibers interrupted without error"),
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not resync the terminal snapshot when writes succeed but no output arrives", async () => {
    vi.useFakeTimers();
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      terminalInstances[0]?.emitData("a");

      await vi.waitFor(() => {
        expect(environment.terminal.write).toHaveBeenCalledWith(
          expect.objectContaining({ data: "a" }),
        );
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      expect(environment.terminal.restart).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not resync after arrow or control input succeeds without output", async () => {
    vi.useFakeTimers();
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      terminalInstances[0]?.emitData("\u001b[A");

      await vi.waitFor(() => {
        expect(environment.terminal.write).toHaveBeenCalledWith(
          expect.objectContaining({ data: "\u001b[A" }),
        );
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      expect(environment.terminal.restart).not.toHaveBeenCalled();

      terminalInstances[0]?.emitData("\u0003");
      await vi.waitFor(() => {
        expect(environment.terminal.write).toHaveBeenCalledWith(
          expect.objectContaining({ data: "\u0003" }),
        );
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      expect(environment.terminal.restart).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies terminal output events without scheduling automatic resync", async () => {
    vi.useFakeTimers();
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    const threadRef = scopeThreadRef("environment-a" as never, THREAD_ID);

    const mounted = await mountTerminalViewport({ threadRef });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });
      terminalInstances[0]?.emitData("a");

      await vi.waitFor(() => {
        expect(environment.terminal.write).toHaveBeenCalledTimes(1);
      });
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, {
        createdAt: "2026-04-07T00:00:01.000Z",
        data: "a",
        terminalId: "default",
        threadId: THREAD_ID,
        type: "output",
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(environment.terminal.open).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("manual resync request reopens and rehydrates the terminal", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({ resyncRequestId: 1 });

      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(2);
      });
      expect(environment.terminal.restart).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("manual restart request restarts without any automatic restart", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      expect(environment.terminal.restart).not.toHaveBeenCalled();
      await mounted.rerender({ restartRequestId: 1 });
      await vi.waitFor(() => {
        expect(environment.terminal.restart).toHaveBeenCalledTimes(1);
      });
      expect(environment.terminal.open).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("drawer toolbar resyncs and restarts only after confirmation", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const mounted = await mountThreadTerminalDrawer({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(1);
      });

      document.querySelector<HTMLButtonElement>("[aria-label='Resync Terminal']")?.click();
      await vi.waitFor(() => {
        expect(environment.terminal.open).toHaveBeenCalledTimes(2);
      });

      document.querySelector<HTMLButtonElement>("[aria-label='Restart Terminal']")?.click();
      await vi.waitFor(() => {
        expect(confirmSpy).toHaveBeenCalledTimes(1);
      });
      expect(environment.terminal.restart).not.toHaveBeenCalled();

      confirmSpy.mockReturnValueOnce(true);
      document.querySelector<HTMLButtonElement>("[aria-label='Restart Terminal']")?.click();

      await vi.waitFor(() => {
        expect(environment.terminal.restart).toHaveBeenCalledTimes(1);
      });
    } finally {
      confirmSpy.mockRestore();
      await mounted.cleanup();
    }
  });

  it("long-pressing a blank line opens a paste-only menu and pastes into the pty", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const showSpy = vi.fn(
      async (_items: ReadonlyArray<{ id: string; label: string }>, _position?: unknown) =>
        "paste" as const,
    );
    readLocalApiMock.mockReturnValue({
      contextMenu: { show: showSpy },
      shell: { openExternal: vi.fn(async () => undefined) },
    });

    const readText = vi.fn(async () => "echo hi");
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => undefined) },
    });

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      });

      const surface = getTerminalSurface();
      const touch = new Touch({
        identifier: 1,
        target: surface,
        clientX: 40,
        clientY: 40,
      });
      surface.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          touches: [touch],
          changedTouches: [touch],
        }),
      );

      await vi.waitFor(
        () => {
          expect(showSpy).toHaveBeenCalledTimes(1);
        },
        { timeout: 2_000 },
      );

      // A blank line offers Paste only — no Copy / Add to chat.
      expect(showSpy.mock.calls[0]?.[0]).toEqual([{ id: "paste", label: "Paste" }]);

      await vi.waitFor(() => {
        expect(readText).toHaveBeenCalledTimes(1);
        expect(environment.terminal.write).toHaveBeenCalledWith(
          expect.objectContaining({ data: "echo hi" }),
        );
      });
    } finally {
      await mounted.cleanup();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      }
      readLocalApiMock.mockReset();
      readLocalApiMock.mockImplementation(() => ({
        contextMenu: { show: vi.fn(async () => null) },
        shell: { openExternal: vi.fn(async () => undefined) },
      }));
    }
  });

  it("blocks mobile edge swipes while long-press dragging terminal selection", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    terminalLineTextByRow.set(0, "  git status done");

    const showSpy = vi.fn(
      async (_items: ReadonlyArray<{ id: string; label: string }>, _position?: unknown) => null,
    );
    readLocalApiMock.mockReturnValue({
      contextMenu: { show: showSpy },
      shell: { openExternal: vi.fn(async () => undefined) },
    });

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalInstances).toHaveLength(1);
      });

      const surface = getTerminalSurface();
      expect(surface).toHaveAttribute("data-mobile-edge-swipe-block", "true");

      const startTouch = createTouch(surface, 7, 85, 8);
      dispatchTouchEvent(surface, "touchstart", [startTouch], [startTouch]);

      await vi.waitFor(
        () => {
          expect(terminalInstances[0]?.select).toHaveBeenCalledWith(6, 0, 6);
        },
        { timeout: 2_000 },
      );
      expect(showSpy).not.toHaveBeenCalled();

      const dragTouch = createTouch(surface, 7, 45, 24);
      dispatchTouchEvent(surface, "touchmove", [dragTouch], [dragTouch]);

      await vi.waitFor(() => {
        expect(terminalInstances[0]?.select).toHaveBeenLastCalledWith(6, 0, 79);
      });
      expect(showSpy).not.toHaveBeenCalled();

      dispatchTouchEvent(surface, "touchend", [], [dragTouch]);

      await vi.waitFor(() => {
        expect(showSpy).toHaveBeenCalledTimes(1);
      });
      expect(showSpy.mock.calls[0]?.[0]).toEqual([
        { id: "copy", label: "Copy" },
        { id: "paste", label: "Paste" },
        { id: "add-to-chat", label: "Add to chat" },
      ]);
    } finally {
      await mounted.cleanup();
      readLocalApiMock.mockReset();
      readLocalApiMock.mockImplementation(() => ({
        contextMenu: { show: vi.fn(async () => null) },
        shell: { openExternal: vi.fn(async () => undefined) },
      }));
    }
  });

  it("uses the drawer surface colors for the terminal theme", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      drawerBackgroundColor: "rgb(24, 28, 36)",
      drawerTextColor: "rgb(228, 232, 240)",
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      });

      expect(terminalConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: expect.objectContaining({
            background: "rgb(24, 28, 36)",
            foreground: "rgb(228, 232, 240)",
          }),
          wordSeparator: TERMINAL_WORD_SEPARATORS,
        }),
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
