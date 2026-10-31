import type { AnyRouter } from "@tanstack/react-router";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// layoutStore reads whether a layout was saved when it loads; earlier browser test files
// share this origin's storage, so clear it before the imports below evaluate.
vi.hoisted(() => window.localStorage.removeItem("t3code:layout-state:v2"));

import { act, render } from "../../test/render";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { openLayoutNewThreadTab } from "../layout/layoutActions";
import {
  createLayoutState,
  findLayoutSurfaceTabs,
  selectFocusedTab,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutTabContent,
} from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { useLayoutSurfaceSync } from "../layout/surfaceSync";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { installChatRouteCommands } from "./chatRouteCommands";

type Match = { readonly routeId: string; readonly pathname: string };

function routerAt(matches: Match[]) {
  const state = { matches: matches.map((match) => ({ ...match, params: {} })) };
  return {
    router: { state } as unknown as AnyRouter,
    navigate: (next: Match[]) => {
      state.matches = next.map((match) => ({ ...match, params: {} }));
    },
  };
}

const CHAT: Match[] = [
  { routeId: "__root__", pathname: "/" },
  { routeId: "/_chat", pathname: "/" },
];

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

function selectThread(threadKey: string) {
  useThreadSelectionStore.getState().clearSelection();
  useThreadSelectionStore.getState().toggleThread(threadKey);
}

describe("chat route commands", () => {
  it("adopts open surfaces as their chats restore, retaining focus and later user closes", async () => {
    using stack = new DisposableStack();
    const layout = useLayoutStore.getState().layout;
    const panels = useRightPanelStore.getState();
    const terminals = useTerminalUiStateStore.getState();
    stack.defer(() => useLayoutStore.setState({ layout }));
    stack.defer(() => useRightPanelStore.setState(panels));
    stack.defer(() => useTerminalUiStateStore.setState(terminals));
    useLayoutStore.setState({ layout: createLayoutState() });
    useRightPanelStore.setState({ byThreadKey: {} });
    useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
    const first = scopeThreadRef(EnvironmentId.make("first"), ThreadId.make("thread"));
    const later = scopeThreadRef(EnvironmentId.make("later"), ThreadId.make("thread"));
    for (const threadRef of [first, later]) {
      useRightPanelStore.getState().open(threadRef, "files");
      useRightPanelStore.getState().open(threadRef, "diff");
      useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    }
    function SurfaceSync() {
      useLayoutSurfaceSync();
      return null;
    }
    await using screen = await render(createElement(SurfaceSync));
    for (const threadRef of [first, later]) {
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
      ).toBe(true);
      expect(
        selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          threadRef,
        ).terminalOpen,
      ).toBe(true);
      await act(() =>
        useLayoutStore
          .getState()
          .openTab(
            { kind: "chat", target: { kind: "server", threadRef } },
            { placement: "new-column" },
          ),
      );
      const restored = findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef);
      expect(
        restored.map(({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId).sort(),
      ).toEqual(["diff", "files", THREAD_TERMINAL_SURFACE_ID].sort());
      expect(
        restored.find(
          ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === "diff",
        )?.pane.activeTabId,
      ).toBe(
        restored.find(
          ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === "diff",
        )?.tab.id,
      );
      expect(selectFocusedTab(useLayoutStore.getState().layout)?.content).toEqual({
        kind: "chat",
        target: { kind: "server", threadRef },
      });
    }
    await act(() => {
      useRightPanelStore.getState().close(first);
      useTerminalUiStateStore.getState().setTerminalOpen(first, false);
      useLayoutStore.getState().focusTab(selectFocusedTab(useLayoutStore.getState().layout)!.id);
    });
    expect(findLayoutSurfaceTabs(useLayoutStore.getState().layout, first)).toEqual([]);
    await screen.unmount();
    await using _remounted = await render(createElement(SurfaceSync));
    expect(findLayoutSurfaceTabs(useLayoutStore.getState().layout, first)).toEqual([]);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(first)]?.isOpen).toBe(false);
  });

  it("starts drafts in the focused chat, launcher or surface project while the route stays elsewhere", async () => {
    using stack = new DisposableStack();
    const layout = useLayoutStore.getState().layout;
    const drafts = useComposerDraftStore.getState();
    stack.defer(() => useLayoutStore.setState({ layout }));
    stack.defer(() => useComposerDraftStore.setState(drafts));
    useLayoutStore.setState({ layout: createLayoutState() });
    const routeDraft = DraftId.make("route-draft");
    const focusedDraft = DraftId.make("focused-draft");
    const routeProject = scopeProjectRef(
      EnvironmentId.make("route"),
      ProjectId.make("route-project"),
    );
    const focusedProject = scopeProjectRef(
      EnvironmentId.make("focused"),
      ProjectId.make("focused-project"),
    );
    const threadRef = scopeThreadRef(focusedProject.environmentId, ThreadId.make("focused-thread"));
    useComposerDraftStore.getState().setProjectDraftThreadId(routeProject, routeDraft);
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(focusedProject, focusedDraft, { threadId: threadRef.threadId });
    const navigate = vi.fn<(request: { params: { draftId: DraftId } }) => Promise<void>>(
      async () => {},
    );
    const router = {
      state: {
        matches: [{ params: { draftId: routeDraft } }],
        location: { pathname: "/draft/route-draft", href: "/draft/route-draft", search: {} },
      },
      navigate,
    } as unknown as AnyRouter;
    stack.defer(installChatRouteCommands(router));
    const content: LayoutTabContent[] = [
      { kind: "chat", target: { kind: "draft", draftId: focusedDraft } },
      { kind: "launcher", id: "launcher", context: { kind: "draft", draftId: focusedDraft } },
      { kind: "surface", threadRef, surfaceId: "files" },
    ];
    for (const tab of content) {
      useLayoutStore.getState().openTab(tab);
      navigate.mockClear();
      expect(openLayoutNewThreadTab()).toBe(true);
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
      const request = navigate.mock.calls[0]![0];
      expect(
        useComposerDraftStore.getState().getDraftSession(request.params.draftId),
      ).toMatchObject(focusedProject);
    }
  });

  it("clears a selection made after install, reading the store at keypress time", () => {
    const { router } = routerAt(CHAT);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    stack.defer(() => useThreadSelectionStore.getState().clearSelection());

    selectThread("env:thread-1");
    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
    // With nothing selected, Escape is left for other handlers.
    expect(pressEscape().defaultPrevented).toBe(false);
  });

  it("stays out of the way off the chat route and under modal pages", () => {
    const { router, navigate } = routerAt([{ routeId: "__root__", pathname: "/pair" }]);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    stack.defer(() => useThreadSelectionStore.getState().clearSelection());
    selectThread("env:thread-1");

    expect(pressEscape().defaultPrevented).toBe(false);

    navigate([...CHAT, { routeId: "/_chat/settings", pathname: "/settings" }]);
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);

    navigate(CHAT);
    expect(pressEscape().defaultPrevented).toBe(true);
  });
});
