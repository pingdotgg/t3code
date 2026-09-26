import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  keybindings: [] as ResolvedKeybindingsConfig,
  params: {} as Record<string, string>,
  paletteOpen: false,
  navigate: vi.fn(),
  openPreview: vi.fn(),
  setShortcuts: vi.fn(async () => undefined),
  toast: vi.fn(),
}));

vi.mock("./preview/openPreviewSession", () => ({ openPreviewSession: state.openPreview }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.keybindings }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.params,
}));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: state.openPreview } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => ({}) } }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "catalog"
        ? { isReady: true, entries: new Map([["remote", {}]]) }
        : { status: "live" },
  },
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => ({ projectId: "project-1", worktreePath: null }),
  readProject: () => ({ workspaceRoot: "/work/project" }),
}));
vi.mock("../composerDraftStore", () => {
  const store = {
    getDraftSession: () => null,
    getDraftThreadByRef: () => null,
    getDraftIdByRef: () => null,
  };
  return {
    useComposerDraftStore: Object.assign(
      (select: (value: typeof store) => unknown) => select(store),
      { getState: () => store },
    ),
  };
});
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => state.paletteOpen }));
vi.mock("../lib/editableFocus", () => ({ isEditableFocused: () => false }));
vi.mock("../lib/previewFocus", () => ({ isPreviewFocused: () => false }));
vi.mock("../lib/terminalFocus", () => ({ isTerminalFocused: () => false }));
vi.mock("../modelPickerVisibility", () => ({ isModelPickerOpen: () => false }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));

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
class TestElement extends EventTarget {
  closest(selector: string) {
    return selector === "[data-keybinding-capture]" ? this : null;
  }
}
let renderer: ReactTestRenderer | undefined;
let menuAction: ((action: string) => void) | undefined;

async function render() {
  await act(() => {
    renderer = create(<ReopenClosedViewShortcut />);
  });
}

function press(overrides: Record<string, unknown> = {}) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "T",
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    repeat: false,
    ...overrides,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    params: {},
    paletteOpen: false,
  });
  state.navigate.mockResolvedValue(undefined);
  state.openPreview.mockReset();
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: {
        preview: { setForwardedShortcuts: state.setShortcuts },
        onMenuAction: (listener: typeof menuAction) => {
          menuAction = listener;
          return () => {
            menuAction = undefined;
          };
        },
      },
    }),
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("root reopen shortcut", () => {
  it("restores a tab from settings to its owning remote thread", async () => {
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    await render();
    await act(() => {
      expect(press().defaultPrevented).toBe(true);
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
    expect(state.navigate).toHaveBeenCalledWith({ to: "/$environmentId/$threadId", params: ref });
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("leaves native shortcuts alone without history or while the palette is open", async () => {
    await render();
    expect(press().defaultPrevented).toBe(false);
    await act(() => {
      useClosedViewStore
        .getState()
        .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    });
    state.paletteOpen = true;
    expect(press().defaultPrevented).toBe(false);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(useClosedViewStore.getState().entries).toHaveLength(1);
  });

  it("lets the keybinding recorder capture the chord", async () => {
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    await render();
    const recorder = new TestElement();
    const event = Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), {
      key: "T",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      repeat: false,
    });
    Object.defineProperty(event, "target", { value: recorder });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(useClosedViewStore.getState().entries).toHaveLength(1);
  });

  it("serializes deliberate presses while a browser restore waits for RPC", async () => {
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
    await render();
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

  it("forwards the chord to a focused desktop browser only while history exists", async () => {
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    await render();
    expect(state.setShortcuts).toHaveBeenLastCalledWith([
      expect.objectContaining({ command: "view.reopenClosed" }),
    ]);
    await act(() => {
      menuAction?.("view.reopenClosed");
    });
    expect(useClosedViewStore.getState().entries).toEqual([]);
    expect(state.setShortcuts).toHaveBeenLastCalledWith([]);
  });
});
