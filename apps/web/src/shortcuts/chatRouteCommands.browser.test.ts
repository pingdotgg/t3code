import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

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
