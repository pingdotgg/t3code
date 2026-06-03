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
  }>,
  terminalLineTextByRow: new Map<number, string>(),
  fitAddonFitSpy: vi.fn(),
  fitAddonLoadSpy: vi.fn(),
  environmentApiById: new Map<string, { terminal: { open: ReturnType<typeof vi.fn> } }>(),
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

    write() {}

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

    onData() {
      return { dispose: vi.fn() };
    }

    onSelectionChange() {
      return { dispose: vi.fn() };
    }

    dispose() {
      terminalDisposeSpy();
    }
  },
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: readEnvironmentApiMock,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import { TERMINAL_WORD_SEPARATORS, TerminalViewport } from "./ThreadTerminalDrawer";

const THREAD_ID = ThreadId.make("thread-terminal-browser");

function createEnvironmentApi() {
  return {
    terminal: {
      open: vi.fn(async () => ({
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
      })),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
    },
  };
}

async function mountTerminalViewport(props: {
  threadRef: ReturnType<typeof scopeThreadRef>;
  drawerBackgroundColor?: string;
  drawerTextColor?: string;
}) {
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
      drawerHeight={320}
      keybindings={[]}
    />,
    { container: host },
  );

  return {
    rerender: async (nextProps: { threadRef: ReturnType<typeof scopeThreadRef> }) => {
      await screen.rerender(
        <TerminalViewport
          threadRef={nextProps.threadRef}
          threadId={THREAD_ID}
          terminalId="default"
          terminalLabel="Terminal"
          cwd="/repo/project"
          onSessionExited={() => undefined}
          onAddTerminalContext={() => undefined}
          focusRequestId={0}
          autoFocus={false}
          resizeEpoch={0}
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
    environmentApiById.clear();
    terminalInstances.length = 0;
    terminalLineTextByRow.clear();
    readEnvironmentApiMock.mockClear();
    readLocalApiMock.mockClear();
    terminalConstructorSpy.mockClear();
    terminalDisposeSpy.mockClear();
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
