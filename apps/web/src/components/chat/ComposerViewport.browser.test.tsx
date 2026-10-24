/** Exercises expanding a real rich-text editor without replacing its document or history. */
import type { Editor } from "@tiptap/core";
import { useRef, useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { cn } from "~/lib/utils";
import { ComposerExpandButton } from "./ComposerExpandButton";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { ComposerViewport, useComposerViewport } from "./ComposerViewport";

const LONG_PROMPT = Array.from({ length: 24 }, (_, index) => `Paragraph ${index + 1}`).join("\n");

function EditorFixture({ value, width }: { value: string; width: number }) {
  const { maximized, restoreOnEscape } = useComposerViewport();
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = useState(value);
  const [menuOpen, setMenuOpen] = useState(false);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  return (
    <form
      data-chat-composer-form="true"
      className={cn("relative", maximized && "flex min-h-0 flex-1 flex-col")}
      style={maximized ? undefined : { width }}
    >
      <div ref={setAnchor} className={cn("relative", maximized && "flex min-h-0 flex-1 flex-col")}>
        <ComposerExpandButton anchor={anchor} />
        <ComposerPromptEditor
          editorRef={editorRef}
          value={prompt}
          cursor={prompt.length}
          ariaLabel="Message"
          richTextEnabled
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder="Ask anything"
          containerClassName={maximized ? "min-h-0 flex-1 [&>div]:h-full" : ""}
          className={cn("pr-9", maximized && "h-full max-h-none min-h-0")}
          onChange={(next) => setPrompt(next)}
          onPaste={() => {}}
          onCommandKeyDown={(key, event) => {
            if (key !== "Escape" || !menuOpen) return restoreOnEscape(event);
            setMenuOpen(false);
            return true;
          }}
        />
        {menuOpen && (
          <ComposerCommandMenuLayer anchor={anchor}>
            <div role="listbox" aria-label="Suggestions">
              A matching file
            </div>
          </ComposerCommandMenuLayer>
        )}
      </div>
      <button type="button" onClick={() => setMenuOpen(true)}>
        Show suggestions
      </button>
    </form>
  );
}

function Fixture({
  targetKey = "thread-a",
  value = LONG_PROMPT,
  width = 500,
}: {
  targetKey?: string;
  value?: string;
  width?: number;
}) {
  return (
    <ComposerViewport targetKey={targetKey} contextStrip={false}>
      <EditorFixture value={value} width={width} />
    </ComposerViewport>
  );
}

function editorIn(container: HTMLElement) {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

it("offers expansion after content overflows and hides it when content fits again", async () => {
  await using screen = await render(<Fixture value="Short prompt" />);
  const expand = screen.getByRole("button", { name: "Maximize prompt" });
  await expect.element(expand).not.toBeInTheDocument();
  const editor = editorIn(screen.container);
  await act(async () =>
    editor.commands.setContent({
      type: "doc",
      content: LONG_PROMPT.split("\n").map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    }),
  );
  await expect.element(expand).toBeVisible();
  await act(async () => editor.commands.setContent("Short again"));
  await expect.element(expand).not.toBeInTheDocument();
});

it("detects wrapping overflow when the available width changes", async () => {
  const value = "a long prompt that wraps into several lines ".repeat(6);
  await using screen = await render(<Fixture value={value} width={700} />);
  const expand = screen.getByRole("button", { name: "Maximize prompt" });
  await expect.element(expand).not.toBeInTheDocument();
  await screen.rerender(<Fixture value={value} width={100} />);
  await expect.element(expand).toBeVisible();
  await screen.rerender(<Fixture value={value} width={700} />);
  await expect.element(expand).not.toBeInTheDocument();
});

it("preserves the editor, selection, history and inline space across expansion", async () => {
  await using screen = await render(<Fixture />);
  const editor = editorIn(screen.container);
  const shell = screen.container.querySelector<HTMLElement>('[data-slot="composer-shell"]')!;
  const inlineHeight = shell.getBoundingClientRect().height;
  await act(async () => {
    editor.commands.setTextSelection(5);
    editor.commands.insertContent("edited ");
  });
  const selection = editor.state.selection.from;
  await screen.getByRole("button", { name: "Maximize prompt" }).click();
  await expect.element(screen.getByRole("button", { name: "Restore prompt size" })).toBeVisible();
  expect(editorIn(screen.container)).toBe(editor);
  expect(editor.state.selection.from).toBe(selection);
  expect(shell.getBoundingClientRect().width).toBe(window.innerWidth);
  expect(shell.getBoundingClientRect().height).toBe(window.innerHeight);
  expect(shell.parentElement!.getBoundingClientRect().height).toBe(inlineHeight);
  await act(async () => editor.commands.undo());
  expect(editor.getText()).not.toContain("edited ");
  await screen.getByRole("button", { name: "Restore prompt size" }).click();
  await expect.element(screen.getByRole("button", { name: "Maximize prompt" })).toBeVisible();
  expect(editorIn(screen.container)).toBe(editor);
  expect(editor.view.dom).toBe(document.activeElement);
});

it("stays expanded after shortening the prompt and restores on Escape", async () => {
  await using screen = await render(<Fixture />);
  await screen.getByRole("button", { name: "Maximize prompt" }).click();
  const editor = editorIn(screen.container);
  await act(async () => {
    editor.commands.setContent("A shorter draft");
    editor.view.dom.focus();
  });
  await expect.element(screen.getByRole("button", { name: "Restore prompt size" })).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("button", { name: "Restore prompt size" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveTextContent("A shorter draft");
});

it("keeps suggestions inside the viewport and lets them handle Escape first", async () => {
  await using screen = await render(<Fixture />);
  await screen.getByRole("button", { name: "Maximize prompt" }).click();
  await screen.getByRole("button", { name: "Show suggestions" }).click();
  const editor = editorIn(screen.container);
  await act(async () => editor.commands.focus("start"));
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  const menu = page.getByRole("listbox", { name: "Suggestions" });
  await expect.element(menu).toBeVisible();
  const bounds = menu.element().getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Restore prompt size" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Maximize prompt" })).toBeVisible();
});

it("does not carry maximized state across thread switches", async () => {
  await using screen = await render(<Fixture />);
  await screen.getByRole("button", { name: "Maximize prompt" }).click();
  await expect.element(screen.getByRole("button", { name: "Restore prompt size" })).toBeVisible();
  await screen.rerender(<Fixture targetKey="thread-b" />);
  await expect.element(screen.getByRole("button", { name: "Maximize prompt" })).toBeVisible();
  await screen.rerender(<Fixture targetKey="thread-a" />);
  await expect.element(screen.getByRole("button", { name: "Maximize prompt" })).toBeVisible();
});
