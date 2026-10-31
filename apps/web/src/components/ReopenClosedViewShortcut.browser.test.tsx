import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  keybindings: [] as ResolvedKeybindingsConfig,
  params: {} as Record<string, string>,
  workspaceAvailable: true,
  navigate: vi.fn(),
  openPreview: vi.fn(),
  setShortcuts: vi.fn(async () => undefined),
  toast: vi.fn(),
}));

vi.mock(import("./preview/openPreviewSession"), async (original) => ({
  ...(await original()),
  openPreviewSession: state.openPreview,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.keybindings) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => state.params) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../state/preview"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewEnvironment: { ...actual.previewEnvironment, open: state.openPreview as never },
  };
});
vi.mock(import("../connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([["remote", { target: { _tag: "DirectConnectionTarget" } }]]),
      }) as never,
    },
  };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const live = Atom.make({ status: "live" });
  return {
    ...actual,
    environmentShell: { ...actual.environmentShell, stateValueAtom: (() => live) as never },
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ projectId: "project-1", worktreePath: null })) as never,
  readProject: (() =>
    state.workspaceAvailable ? { workspaceRoot: "/work/project" } : null) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { useClosedViewStore } from "../closedViewStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { ReopenClosedViewShortcut } from "./ReopenClosedViewShortcut";

const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
const snapshot = {
  threadId: ref.threadId,
  tabId: "closed-tab",
  navStatus: { _tag: "Success", url: "https://example.com", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-22T12:00:00.000Z",
} as const;
let menuAction: ((action: string) => void) | undefined;

function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    params: {},
    workspaceAvailable: true,
  });
  state.navigate.mockResolvedValue(undefined);
  state.openPreview.mockReset();
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
}

async function renderShortcut() {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64"));
  window.desktopBridge = {
    preview: { setForwardedShortcuts: state.setShortcuts },
    onMenuAction: (listener: (action: string) => void) => {
      menuAction = listener;
      return () => {
        menuAction = undefined;
      };
    },
  } as unknown as NonNullable<typeof window.desktopBridge>;
  stack.defer(() => {
    delete window.desktopBridge;
  });
  stack.use(await render(<ReopenClosedViewShortcut />));
  const environment = stack.move();
  return {
    /** Attaches an element to the document until the test ends. */
    append(element: HTMLElement) {
      document.body.append(element);
      environment.defer(() => element.remove());
      return element;
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

function press(target: Element = document.body) {
  const event = new KeyboardEvent("keydown", {
    key: "T",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("root reopen shortcut", () => {
  it("serializes deliberate presses while a browser restore waits for RPC", async () => {
    setup();
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "files", id: "files" } });
    useClosedViewStore.getState().remember({ kind: "browser", threadRef: ref, snapshot });
    let finish!: (value: ReturnType<typeof AsyncResult.success>) => void;
    state.openPreview.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await using _view = await renderShortcut();
    await act(() => {
      press();
      press();
    });
    expect(state.openPreview).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
    await act(() => {
      finish(AsyncResult.success({ tabId: "new-tab" }));
    });
    expect(state.navigate).toHaveBeenCalledTimes(2);
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("does not create a second browser when navigation fails after restoring it", async () => {
    setup();
    const store = useClosedViewStore.getState();
    const older = store.remember({
      kind: "panel-tab",
      threadRef: ref,
      surface: { kind: "diff", id: "diff" },
    });
    store.remember({ kind: "browser", threadRef: ref, snapshot });
    state.openPreview.mockResolvedValue(AsyncResult.success({ tabId: "new-tab" }));
    state.navigate.mockRejectedValueOnce(new Error("navigation failed"));
    await using _view = await renderShortcut();
    await act(() => {
      press();
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("browser:new-tab");
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not reopen view" }),
    );
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([older]);
    await act(() => {
      menuAction?.("view.reopenClosed");
    });
    expect(state.openPreview).toHaveBeenCalledOnce();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it.each(["files", "file", "browser"] as const)(
    "keeps a failed %s restore retryable without blocking older history",
    async (kind) => {
      setup();
      const store = useClosedViewStore.getState();
      const older = store.remember({
        kind: "panel-tab",
        threadRef: ref,
        surface: { kind: "diff", id: "diff" },
      });
      const failed = store.remember(
        kind === "browser"
          ? { kind: "browser", threadRef: ref, snapshot }
          : {
              kind: "panel-tab",
              threadRef: ref,
              surface:
                kind === "files"
                  ? { kind: "files", id: "files" }
                  : {
                      kind: "file",
                      id: "file:src/app.ts",
                      relativePath: "src/app.ts",
                      revealLine: null,
                      revealRequestId: 0,
                    },
            },
      );
      state.workspaceAvailable = false;
      state.openPreview.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
      await using _view = await renderShortcut();
      await act(() => {
        press();
      });
      expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([
        older,
        failed,
      ]);
      expect(state.navigate).not.toHaveBeenCalled();
      await act(() => {
        menuAction?.("view.reopenClosed");
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
      ).toBe("diff");
      expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([failed]);
      state.workspaceAvailable = true;
      state.openPreview.mockResolvedValue(AsyncResult.success({ ...snapshot, tabId: "new-tab" }));
      await act(() => {
        press();
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
      ).toBe(
        kind === "browser" ? "browser:new-tab" : kind === "file" ? "file:src/app.ts" : "files",
      );
      expect(useClosedViewStore.getState().entries).toEqual([]);
    },
  );
});
