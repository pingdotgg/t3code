import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";

type OnCite = ComponentProps<typeof AssistantSelectionToolbar>["onCite"];

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

// The chat's window capture listener runs before the toolbar's document listener, so
// type-to-focus sees every key first. The stand-in composer records what it receives.
function ChatShortcuts(props: { composerKeys: string[] }) {
  useChatShortcuts({
    enabled: true,
    keybindings: [],
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          props.composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return null;
}

function Transcript(props: { onCite: OnCite; composerKeys?: string[] }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <>
      {props.composerKeys ? <ChatShortcuts composerKeys={props.composerKeys} /> : null}
      <input aria-label="Find in thread" />
      <div ref={setViewport}>
        <div data-assistant-citation-source="message-1">
          <p>Render the citation chip</p>
        </div>
      </div>
      <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={props.onCite} />
    </>
  );
}

// router: false because the transcript never navigates.
const options = { router: false } as const;
const citeButton = page.getByRole("button", { name: "Cite selection in composer" });

async function selectAssistantText(container: HTMLElement) {
  const text = container.querySelector("p")!.firstChild!;
  window.getSelection()!.setBaseAndExtent(text, 7, text, 15);
  await expect.element(citeButton).toBeVisible();
}

describe("AssistantSelectionToolbar", () => {
  it.each(["r", "R"])("cites the selection when %s is pressed", async (key) => {
    const onCite = vi.fn<OnCite>(() => true);
    await using screen = await render(<Transcript onCite={onCite} />, options);
    await selectAssistantText(screen.container);

    await userEvent.keyboard(key);

    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.lastCall![0]).toMatchObject({ messageId: "message-1", text: "the cita" });
    expect(window.getSelection()!.isCollapsed).toBe(true);
    await expect.element(citeButton).not.toBeInTheDocument();
  });

  it("cites with R instead of typing it into the composer", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} />,
      options,
    );
    await selectAssistantText(screen.container);

    await userEvent.keyboard("r");

    expect(onCite).toHaveBeenCalledOnce();
    expect(composerKeys).toEqual([]);
  });

  it("types R into the composer when nothing is selected", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    const composerKeys: string[] = [];
    await using _screen = await render(
      <Transcript onCite={onCite} composerKeys={composerKeys} />,
      options,
    );

    await userEvent.keyboard("r");

    expect(composerKeys).toEqual(["r"]);
    expect(onCite).not.toHaveBeenCalled();
  });

  it("lets a focused text field keep R", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    await using screen = await render(<Transcript onCite={onCite} />, options);
    await selectAssistantText(screen.container);
    const find = screen.getByRole("textbox", { name: "Find in thread" });
    await userEvent.click(find);

    await userEvent.keyboard("r");

    await expect.element(find).toHaveValue("r");
    expect(onCite).not.toHaveBeenCalled();
  });

  // Dispatched rather than typed so a real Ctrl+R cannot reload the test page.
  it.each([
    ["Cmd+R", { metaKey: true }],
    ["Ctrl+R", { ctrlKey: true }],
    ["Alt+R", { altKey: true }],
  ])("leaves %s to the browser", async (_name, modifier) => {
    const onCite = vi.fn<OnCite>(() => true);
    await using screen = await render(<Transcript onCite={onCite} />, options);
    await selectAssistantText(screen.container);

    const event = new KeyboardEvent("keydown", {
      key: "r",
      bubbles: true,
      cancelable: true,
      ...modifier,
    });
    document.body.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();
  });

  it("still focuses the Cite action on Tab", async () => {
    const onCite = vi.fn<OnCite>(() => true);
    await using screen = await render(<Transcript onCite={onCite} />, options);
    await selectAssistantText(screen.container);

    await userEvent.keyboard("{Tab}");

    await expect.element(citeButton).toHaveFocus();
    expect(onCite).not.toHaveBeenCalled();
  });
});
