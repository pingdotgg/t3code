import "../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  terminalConstructorSpy,
  terminalDisposeSpy,
  fitAddonFitSpy,
  fitAddonLoadSpy,
  environmentApiById,
  readEnvironmentApiMock,
  readLocalApiMock,
} = vi.hoisted(() => ({
  terminalConstructorSpy: vi.fn(),
  terminalDisposeSpy: vi.fn(),
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
    options: { theme?: unknown } = {};
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => null),
      },
    };

    constructor(options: unknown) {
      terminalConstructorSpy(options);
    }

    loadAddon(addon: unknown) {
      fitAddonLoadSpy(addon);
    }

    open() {}

    write() {}

    clear() {}

    clearSelection() {}

    focus() {}

    refresh() {}

    scrollToBottom() {}

    hasSelection() {
      return false;
    }

    getSelection() {
      return "";
    }

    getSelectionPosition() {
      return null;
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

import { TerminalViewport } from "./ThreadTerminalDrawer";

const THREAD_ID = ThreadId.makeUnsafe("thread-terminal-browser");

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
        />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      drawer.remove();
    },
  };
}

describe("TerminalViewport", () => {
  afterEach(() => {
    environmentApiById.clear();
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
        }),
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
