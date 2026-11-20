import type { AnyRouter } from "@tanstack/react-router";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRef, type ReactElement, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommandPaletteMount, useCommandPaletteStore } from "../commandPaletteStore";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../components/ComposerPromptEditorTiptap";
import { isMacPlatform } from "../lib/utils";
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

function pressMod(key: string): KeyboardEvent {
  const mac = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: mac,
    ctrlKey: !mac,
    cancelable: true,
    bubbles: true,
  });
  document.activeElement?.dispatchEvent(event);
  return event;
}

function selectThread(threadKey: string) {
  useThreadSelectionStore.getState().clearSelection();
  useThreadSelectionStore.getState().toggleThread(threadKey);
}

function Composer(props: {
  vimEnabled: boolean;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
}): ReactElement {
  useCommandPaletteMount();
  return (
    <ComposerPromptEditorTiptap
      value={"first line\nsecond line"}
      cursor={0}
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      vimEnabled={props.vimEnabled}
      editorRef={props.editorRef}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder="Prompt"
      onChange={() => {}}
      onPaste={() => {}}
    />
  );
}

describe("chat route commands", () => {
  it("leaves zoom keys to the app unless the focused right panel shows a browser", () => {
    const { router } = routerAt(CHAT);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const panel = document.createElement("div");
    panel.setAttribute("data-preview-panel-mode", "inline");
    const pullRequestTab = document.createElement("button");
    panel.append(pullRequestTab);
    document.body.append(panel);
    stack.defer(() => panel.remove());
    pullRequestTab.focus();

    for (const key of ["=", "+", "-", "0"]) expect(pressMod(key).defaultPrevented).toBe(false);

    const browser = document.createElement("div");
    browser.setAttribute("data-preview-view", "");
    panel.append(browser);
    for (const key of ["=", "+", "-", "0"]) expect(pressMod(key).defaultPrevented).toBe(true);
  });
  it.each(["normal", "insert", "off"] as const)(
    "opens the new-thread picker from the focused composer with Vim %s",
    async (mode) => {
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
      const { router } = routerAt(CHAT);
      using stack = new DisposableStack();
      stack.defer(installChatRouteCommands(router));
      const editorRef = createRef<ComposerPromptEditorHandle>();
      await using screen = await render(
        <Composer vimEnabled={mode !== "off"} editorRef={editorRef} />,
      );
      await userEvent.click(screen.getByRole("textbox"));
      if (mode === "insert") await userEvent.keyboard("i");
      const before = editorRef.current?.readSnapshot();

      await userEvent.keyboard("{Control>}n{/Control}");

      await vi.waitFor(() => {
        expect(useCommandPaletteStore.getState()).toMatchObject({
          open: true,
          openIntent: { kind: "new-thread-in" },
        });
      });
      expect(editorRef.current?.readSnapshot()).toEqual(before);
    },
  );

  it("lets the composer handle Escape before clearing a selection made after install", async () => {
    const { router } = routerAt(CHAT);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    stack.defer(() => useThreadSelectionStore.getState().clearSelection());
    const editorRef = createRef<ComposerPromptEditorHandle>();
    await using screen = await render(<Composer vimEnabled editorRef={editorRef} />);
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("i");

    selectThread("env:thread-1");
    await userEvent.keyboard("{Escape}");
    expect(screen.container.querySelector("[data-vim-mode]")?.getAttribute("data-vim-mode")).toBe(
      "normal",
    );
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);
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
