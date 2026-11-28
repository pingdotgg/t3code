import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("local");
const parentRef = scopeThreadRef(environmentId, ThreadId.make("parent"));
const subagentRef = scopeThreadRef(environmentId, ThreadId.make("subagent"));

const dialogsConfirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
const readLocalApiMock = vi.fn(() => ({ dialogs: { confirm: dialogsConfirmMock } }));

vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => readLocalApiMock()) as never,
}));

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (() => true) as never,
}));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadLineage: ((ref: typeof subagentRef) =>
    ref.threadId === subagentRef.threadId
      ? { parentThreadId: parentRef.threadId, relationshipToParent: "subagent" }
      : null) as never,
}));

import { useClosedViewStore } from "../closedViewStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import * as terminalCloseConfirm from "../lib/terminalCloseConfirm";
import {
  __testing as previewTesting,
  previewStateAtom,
  resetPreviewStateForTests,
} from "../previewStateStore";
import { planNextReopen, reopenClosedView } from "../reopenClosedView";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import * as sessionState from "../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  closeLayoutTabByUser,
  closeLayoutTabsByUser,
  closeOtherLayoutTabsByUser,
  createLayoutNewTabContent,
  toggleFocusedLayoutFill,
} from "./layoutActions";
import {
  createLayoutState,
  findLayoutTab,
  selectFocusedTab,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutTabContent,
} from "./layoutModel";
import {
  runInNewLayoutTab,
  subscribeLayoutThreadsClosedByUser,
  useLayoutStore,
} from "./layoutStore";

const parent: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef: parentRef } };
const subagent: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: subagentRef },
};
const other: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("other")) },
};

function setup(contents: ReadonlyArray<LayoutTabContent>) {
  const original = useLayoutStore.getState();
  useLayoutStore.setState({
    layout: createLayoutState(),
    maximizedTabId: null,
    filledContentKeys: new Set(),
  });
  for (const content of contents) {
    useLayoutStore.getState().openTab(content, { placement: "active-pane", position: "end" });
  }
  const closed: unknown[] = [];
  const unsubscribe = subscribeLayoutThreadsClosedByUser((targets) => closed.push(...targets));
  return {
    closed,
    tabOf: (content: LayoutTabContent) =>
      findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content === content)?.tab,
    chats: () =>
      useLayoutStore
        .getState()
        .layout.workspaces.flatMap((workspace) => workspace.columns)
        .flatMap((column) => column.panes)
        .flatMap((pane) => pane.tabs.map((tab) => tab.content))
        .filter((content) => content.kind === "chat"),
    [Symbol.dispose]: () => {
      unsubscribe();
      useLayoutStore.setState(original);
    },
  };
}

describe("closeLayoutTabByUser", () => {
  it("returns a subagent's tab to its parent thread without closing or settling the parent", () => {
    using layout = setup([other, subagent]);
    const subagentTab = layout.tabOf(subagent)!;
    closeLayoutTabByUser(subagentTab.id);
    expect(selectFocusedTab(useLayoutStore.getState().layout)).toEqual({
      ...subagentTab,
      content: parent,
    });
    expect(layout.chats()).toEqual([other, parent]);
    expect(layout.closed).toEqual([]);
  });

  it("closes a subagent's tab onto the parent's own tab when the parent is already open", () => {
    using layout = setup([parent, other, subagent]);
    const parentTab = layout.tabOf(parent)!;
    closeLayoutTabByUser(layout.tabOf(subagent)!.id);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(parentTab.id);
    expect(layout.chats()).toEqual([parent, other]);
    expect(layout.closed).toEqual([]);
  });

  it("closes a subagent's tab outright when closing the others", () => {
    using layout = setup([other, subagent]);
    closeOtherLayoutTabsByUser(layout.tabOf(other)!.id);
    expect(layout.chats()).toEqual([other]);
  });

  it("asks once before closing sibling terminal tabs and keeps them when cancelled", async () => {
    const scopeSpy = vi.spyOn(sessionState, "readEnvironmentScope").mockReturnValue(true);
    const confirmSpy = vi
      .spyOn(terminalCloseConfirm, "confirmTerminalClose")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const previousTerminalUi = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    const previousRightPanel = useRightPanelStore.getState().byThreadKey;
    try {
      useTerminalUiStateStore.getState().setTerminalOpen(parentRef, true);
      useRightPanelStore.getState().openTerminal(parentRef, "term-2");
      const terminalSurfaceId = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        parentRef,
      ).surfaces.find((surface) => surface.kind === "terminal")!.id;
      const threadTerminal: LayoutTabContent = {
        kind: "surface",
        threadRef: parentRef,
        surfaceId: THREAD_TERMINAL_SURFACE_ID,
      };
      const panelTerminal: LayoutTabContent = {
        kind: "surface",
        threadRef: parentRef,
        surfaceId: terminalSurfaceId,
      };
      using layout = setup([other, threadTerminal, panelTerminal]);
      const keepId = layout.tabOf(other)!.id;

      closeOtherLayoutTabsByUser(keepId);
      await Promise.resolve();
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy.mock.calls[0]?.[0]).toHaveLength(2);
      expect(layout.tabOf(threadTerminal)).toBeDefined();
      expect(layout.tabOf(panelTerminal)).toBeDefined();

      closeOtherLayoutTabsByUser(keepId);
      await vi.waitFor(() => {
        expect(
          selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            parentRef,
          ).terminalOpen,
        ).toBe(false);
        expect(
          selectThreadRightPanelState(
            useRightPanelStore.getState().byThreadKey,
            parentRef,
          ).surfaces.find((surface) => surface.id === terminalSurfaceId),
        ).toBeUndefined();
      });
      expect(confirmSpy).toHaveBeenCalledTimes(2);
    } finally {
      scopeSpy.mockRestore();
      confirmSpy.mockRestore();
      useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: previousTerminalUi });
      useRightPanelStore.setState({ byThreadKey: previousRightPanel });
    }
  });

  it.each([{ contents: [subagent, other] }, { contents: [parent, subagent, other] }])(
    "closes a background subagent tab without opening or focusing its parent: $contents",
    ({ contents }) => {
      using layout = setup(contents);
      const focused = selectFocusedTab(useLayoutStore.getState().layout);
      closeLayoutTabByUser(layout.tabOf(subagent)!.id);
      expect(selectFocusedTab(useLayoutStore.getState().layout)).toBe(focused);
      expect(layout.chats()).toEqual(contents.filter((content) => content !== subagent));
    },
  );

  it("closes selected tabs together and remembers the active tab last so it reopens first", () => {
    using layout = setup([other, parent, subagent]);
    useClosedViewStore.setState({ entries: [] });
    const otherTab = layout.tabOf(other)!;
    const parentTab = layout.tabOf(parent)!;
    const subagentTab = layout.tabOf(subagent)!;
    useLayoutStore.getState().focusTab(parentTab.id);

    closeLayoutTabsByUser([parentTab.id, subagentTab.id]);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(otherTab.id);
    expect(layout.chats()).toEqual([other]);
    expect(useClosedViewStore.getState().entries[0]).toMatchObject({
      kind: "chat",
      threadRef: parentRef,
    });
  });

  it("confirms once before closing selected panel and thread terminal tabs, and closes nothing when declined", async () => {
    const previousSettings = getClientSettings();
    const previousPanels = useRightPanelStore.getState().byThreadKey;
    const previousTerminals = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, confirmTerminalClose: true });
    dialogsConfirmMock.mockReset();

    const parentKey = scopedThreadKey(parentRef);
    useRightPanelStore.getState().openTerminal(parentRef, "panel-term-1");
    const panelTerminalId = useRightPanelStore
      .getState()
      .byThreadKey[parentKey]!.surfaces.find((surface) => surface.kind === "terminal")!.id;
    useTerminalUiStateStore.getState().setTerminalOpen(parentRef, true);

    const panelTerminalContent: LayoutTabContent = {
      kind: "surface",
      threadRef: parentRef,
      surfaceId: panelTerminalId,
    };
    const threadTerminalContent: LayoutTabContent = {
      kind: "surface",
      threadRef: parentRef,
      surfaceId: THREAD_TERMINAL_SURFACE_ID,
    };

    try {
      using layout = setup([other, panelTerminalContent, threadTerminalContent]);
      const otherTab = layout.tabOf(other)!;
      const panelTerminalTab = layout.tabOf(panelTerminalContent)!;
      const threadTerminalTab = layout.tabOf(threadTerminalContent)!;

      dialogsConfirmMock.mockResolvedValueOnce(false);
      closeLayoutTabsByUser([otherTab.id, panelTerminalTab.id, threadTerminalTab.id]);
      await vi.waitFor(() => expect(dialogsConfirmMock).toHaveBeenCalledTimes(1));
      expect(dialogsConfirmMock.mock.calls[0]![0]).toContain("2 terminals");
      // Declining closes neither the terminals nor the non-surface tab.
      expect(layout.tabOf(other)).toBeDefined();
      expect(
        useRightPanelStore
          .getState()
          .byThreadKey[parentKey]?.surfaces.some((surface) => surface.id === panelTerminalId),
      ).toBe(true);
      expect(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey[parentKey]?.terminalOpen,
      ).toBe(true);

      // Accepting closes all selected tabs after a single prompt.
      dialogsConfirmMock.mockResolvedValueOnce(true);
      closeLayoutTabsByUser([otherTab.id, panelTerminalTab.id, threadTerminalTab.id]);
      await vi.waitFor(() => {
        expect(layout.tabOf(other)).toBeUndefined();
        expect(
          useRightPanelStore
            .getState()
            .byThreadKey[parentKey]?.surfaces.some((surface) => surface.id === panelTerminalId) ??
            false,
        ).toBe(false);
        expect(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey[parentKey]?.terminalOpen ??
            false,
        ).toBe(false);
      });
      expect(dialogsConfirmMock).toHaveBeenCalledTimes(2);

      // With confirmTerminalClose off, closing selected terminals skips the prompt.
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, confirmTerminalClose: false });
      useRightPanelStore.getState().openTerminal(parentRef, "panel-term-2");
      const secondPanelTerminalId = useRightPanelStore
        .getState()
        .byThreadKey[parentKey]!.surfaces.find((surface) => surface.kind === "terminal")!.id;
      const secondTerminalContent: LayoutTabContent = {
        kind: "surface",
        threadRef: parentRef,
        surfaceId: secondPanelTerminalId,
      };
      useLayoutStore.getState().openTab(other, { placement: "active-pane", position: "end" });
      useLayoutStore
        .getState()
        .openTab(secondTerminalContent, { placement: "active-pane", position: "end" });
      closeLayoutTabsByUser([layout.tabOf(other)!.id, layout.tabOf(secondTerminalContent)!.id]);
      await vi.waitFor(() => {
        expect(layout.tabOf(other)).toBeUndefined();
        expect(
          useRightPanelStore
            .getState()
            .byThreadKey[parentKey]?.surfaces.some(
              (surface) => surface.id === secondPanelTerminalId,
            ) ?? false,
        ).toBe(false);
      });
      expect(dialogsConfirmMock).toHaveBeenCalledTimes(2);
    } finally {
      __setClientSettingsForTests(previousSettings);
      useRightPanelStore.setState({ byThreadKey: previousPanels });
      useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: previousTerminals });
    }
  });

  it("confirms once across threads for agent-controlled browsers and closes nothing when declined", async () => {
    const previousPanels = useRightPanelStore.getState().byThreadKey;
    dialogsConfirmMock.mockReset();
    useClosedViewStore.setState({ entries: [] });
    resetPreviewStateForTests();

    const parentKey = scopedThreadKey(parentRef);
    const subagentKey = scopedThreadKey(subagentRef);
    useRightPanelStore.getState().openBrowser(parentRef, "browser-a");
    useRightPanelStore.getState().open(parentRef, "diff");
    useRightPanelStore.getState().openBrowser(subagentRef, "browser-b");

    const agentOverlay = {
      hasWebContents: true,
      navStatus: { _tag: "Idle" as const },
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system" as const,
      audioMuted: false,
      audible: false,
      controller: "agent" as const,
      favicon: null,
    };
    appAtomRegistry.set(previewStateAtom(parentKey), {
      ...previewTesting.EMPTY_THREAD_PREVIEW_STATE,
      desktopByTabId: { "browser-a": agentOverlay },
    });
    appAtomRegistry.set(previewStateAtom(subagentKey), {
      ...previewTesting.EMPTY_THREAD_PREVIEW_STATE,
      desktopByTabId: { "browser-b": agentOverlay },
    });

    const browserA: LayoutTabContent = {
      kind: "surface",
      threadRef: parentRef,
      surfaceId: "browser:browser-a",
    };
    const diffSurface: LayoutTabContent = {
      kind: "surface",
      threadRef: parentRef,
      surfaceId: "diff",
    };
    const browserB: LayoutTabContent = {
      kind: "surface",
      threadRef: subagentRef,
      surfaceId: "browser:browser-b",
    };

    try {
      using layout = setup([other, browserA, diffSurface, browserB]);
      const otherTab = layout.tabOf(other)!;
      const browserATab = layout.tabOf(browserA)!;
      const diffTab = layout.tabOf(diffSurface)!;
      const browserBTab = layout.tabOf(browserB)!;

      // Declining closes nothing — not even the non-surface chat tab — and prompts only once.
      dialogsConfirmMock.mockResolvedValueOnce(false);
      closeLayoutTabsByUser([otherTab.id, browserATab.id, diffTab.id, browserBTab.id]);
      await vi.waitFor(() => expect(dialogsConfirmMock).toHaveBeenCalledTimes(1));
      expect(dialogsConfirmMock.mock.calls[0]![0]).toContain("2 browsers");
      expect(layout.tabOf(other)).toBeDefined();
      expect(useClosedViewStore.getState().entries).toEqual([]);
      expect(
        useRightPanelStore
          .getState()
          .byThreadKey[parentKey]?.surfaces.some((surface) => surface.id === "browser:browser-a"),
      ).toBe(true);
      expect(
        useRightPanelStore
          .getState()
          .byThreadKey[subagentKey]?.surfaces.some((surface) => surface.id === "browser:browser-b"),
      ).toBe(true);

      // Accepting closes everything after a single prompt.
      dialogsConfirmMock.mockResolvedValueOnce(true);
      closeLayoutTabsByUser([otherTab.id, browserATab.id, diffTab.id, browserBTab.id]);
      await vi.waitFor(() => {
        expect(layout.tabOf(other)).toBeUndefined();
        expect(
          useRightPanelStore
            .getState()
            .byThreadKey[parentKey]?.surfaces.some(
              (surface) => surface.id === "browser:browser-a",
            ) ?? false,
        ).toBe(false);
        expect(
          useRightPanelStore
            .getState()
            .byThreadKey[subagentKey]?.surfaces.some(
              (surface) => surface.id === "browser:browser-b",
            ) ?? false,
        ).toBe(false);
      });
      expect(dialogsConfirmMock).toHaveBeenCalledTimes(2);
    } finally {
      resetPreviewStateForTests();
      useRightPanelStore.setState({ byThreadKey: previousPanels });
    }
  });

  it("remembers the active non-surface tab last so Cmd+Shift+T restores it first on mixed selections", () => {
    const previousPanels = useRightPanelStore.getState().byThreadKey;
    useClosedViewStore.setState({ entries: [] });
    useRightPanelStore.getState().open(parentRef, "diff");
    useRightPanelStore.getState().openFile(parentRef, "package.json");
    const fileSurfaceId = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(parentRef)]!.surfaces.find(
        (surface) => surface.kind === "file",
      )!.id;

    const diffContent: LayoutTabContent = {
      kind: "surface",
      threadRef: parentRef,
      surfaceId: "diff",
    };
    const fileContent: LayoutTabContent = {
      kind: "surface",
      threadRef: parentRef,
      surfaceId: fileSurfaceId,
    };

    try {
      using layout = setup([parent, diffContent, fileContent, other]);
      const parentTab = layout.tabOf(parent)!;
      const diffTab = layout.tabOf(diffContent)!;
      const fileTab = layout.tabOf(fileContent)!;
      useLayoutStore.getState().focusTab(parentTab.id);

      closeLayoutTabsByUser([parentTab.id, diffTab.id, fileTab.id]);
      expect(useClosedViewStore.getState().entries[0]).toMatchObject({
        kind: "chat",
        threadRef: parentRef,
      });
    } finally {
      useRightPanelStore.setState({ byThreadKey: previousPanels });
    }
  });
});

describe("reopening a closed list page", () => {
  it.each([
    { kind: "issues", href: "/issues?status=closed" },
    { kind: "pull-requests", href: "/pull-requests?state=merged" },
    { kind: "workflows", href: "/workflows" },
  ] as const)("puts the $kind tab back where it was, with its URL", async (content) => {
    using layout = setup([other, content, parent]);
    useClosedViewStore.setState({ entries: [] });
    const page = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content === content)!;
    closeLayoutTabByUser(page.tab.id);
    expect(layout.tabOf(content)).toBeUndefined();
    const { restore } = planNextReopen(useClosedViewStore.getState().entries, () => ({
      environmentKnown: true,
      catalogReady: true,
      ownerExists: true,
      sideChatExists: true,
      shellLive: true,
      panel: { isOpen: false, activeSurfaceId: null, surfaces: [] },
    }));
    expect(
      await reopenClosedView(restore!, { openPreview: vi.fn(), workspaceAvailable: true }),
    ).toBe(true);
    const reopened = findLayoutTab(
      useLayoutStore.getState().layout,
      (tab) => tab.content.kind === content.kind,
    )!;
    expect(reopened.tab.content).toEqual(content);
    expect([reopened.pane.id, reopened.tabIndex]).toEqual([page.pane.id, page.tabIndex]);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(reopened.tab.id);
  });
});

describe("toggleFocusedLayoutFill", () => {
  it("restores a filled thread when returning to its tab and lets it unfill", () => {
    using layout = setup([parent, other]);
    const store = useLayoutStore.getState();
    const tabId = layout.tabOf(parent)!.id;
    store.focusTab(tabId);
    toggleFocusedLayoutFill();
    expect(useLayoutStore.getState().maximizedTabId).toBe(tabId);
    store.focusTab(layout.tabOf(other)!.id);
    expect(useLayoutStore.getState().maximizedTabId).toBeNull();
    store.focusTab(tabId);
    expect(useLayoutStore.getState().maximizedTabId).toBe(tabId);
    toggleFocusedLayoutFill();
    expect(useLayoutStore.getState().maximizedTabId).toBeNull();
    toggleFocusedLayoutFill();
    store.replaceTabContent(tabId, subagent);
    expect(useLayoutStore.getState().maximizedTabId).toBeNull();
    store.replaceTabContent(tabId, parent);
    expect(useLayoutStore.getState().maximizedTabId).toBe(tabId);
    toggleFocusedLayoutFill();
  });
});

describe("runInNewLayoutTab", () => {
  it("keeps a later new tab request when an earlier one settles", async () => {
    vi.useFakeTimers();
    try {
      let finishFirst = () => {};
      const first = runInNewLayoutTab(
        () => new Promise<void>((resolve) => (finishFirst = resolve)),
      );
      // The first route rendered and took its request.
      useLayoutStore.getState().clearNewTabRequest();
      void runInNewLayoutTab(() => new Promise<void>(() => {}));
      finishFirst();
      await first;
      vi.runAllTimers();
      expect(useLayoutStore.getState().newTabRequest).not.toBeNull();
    } finally {
      vi.useRealTimers();
      useLayoutStore.getState().clearNewTabRequest();
    }
  });
});

describe("createLayoutNewTabContent", () => {
  it("keeps draft context when opening a new tab from a draft's surface tab", () => {
    const draftId = DraftId.make("draft-1");
    const draftThreadRef = scopeThreadRef(environmentId, ThreadId.make("draft-thread"));
    const surface: LayoutTabContent = {
      kind: "surface",
      threadRef: draftThreadRef,
      surfaceId: "files",
    };
    const spy = vi
      .spyOn(useComposerDraftStore.getState(), "getDraftIdByRef")
      .mockReturnValue(draftId);
    try {
      using layout = setup([surface]);
      const surfaceTab = layout.tabOf(surface)!;
      expect(createLayoutNewTabContent(surfaceTab.id).context).toEqual({
        kind: "draft",
        draftId,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
