import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const draft =
  "> **Assistant and reasoning text still save intermediate full snapshots**, using the existing 50 ms batching. Compaction still preserves their `turn-item.updated` events. [Code](/Users/yashsingh/p/projects/t3code/apps/server/src/orchestration-v2/ProjectionMaintenance.ts:235)";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountEditor(value: string, richTextEnabled = true) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={0}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
    ),
  );
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, ...options });
  const handled = editor.view.props.handleKeyDown?.(editor.view, event);
  expect(event.defaultPrevented).toBe(Boolean(handled));
  return handled;
}

it("keeps Up before the opening bold marker in a quote, including while typing", async () => {
  const editor = await mountEditor(draft);
  const position = editor.state.selection.from;
  await act(async () => {
    editor.view.focus();
    expect(press(editor, "ArrowUp")).toBe(true);
    expect(editor.state.selection.from).toBe(position);
    editor.view.updateState(editor.state);
    const marker = editor.view.dom.querySelector(".composer-rich-marker");
    const caret = window.getSelection()?.getRangeAt(0);
    if (!marker || !caret) throw new Error("Caret or bold marker is missing");
    const markerRange = document.createRange();
    markerRange.selectNode(marker);
    expect(caret.compareBoundaryPoints(Range.START_TO_START, markerRange)).toBeLessThanOrEqual(0);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> x**"));
});

it("keeps Down after a closing marker, including while typing", async () => {
  const editor = await mountEditor("> **bold**");
  await act(async () => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    expect(press(editor, "ArrowDown")).toBe(true);
    expect(press(editor, "ArrowDown")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("> **bold**x");
});

it("leaves vertical navigation between paragraphs to the browser", async () => {
  const editor = await mountEditor("**first**\n**second**");
  await act(async () => {
    const first = editor.state.doc.child(0);
    editor.commands.setTextSelection(first.nodeSize + 1);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.setTextSelection(first.nodeSize - 1);
    expect(press(editor, "ArrowDown")).toBe(false);
  });
});

it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { isComposing: true }])(
  "preserves modified Up behavior for %j",
  async (options) => {
    const editor = await mountEditor(draft);
    await act(async () => {
      expect(press(editor, "ArrowUp", options)).toBe(false);
      editor.commands.insertContent("x");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
  },
);

describe("macOS boundary navigation", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    container.style.width = "600px";
  });

  const markdown = String.raw`Fixed the top padding to 16px and updated the offline index and ZIP.

**Yes: [HW08, problem 6, page 2](/Users/yashsingh/.t3/scratch/2026-10-16-gather-all-info-about-the-2fcd52f5/calculus-resources/files/HW08.pdf)** asks for the absolute maximum and minimum of
\[
f(x,y)=2x^2+y^2,\qquad x^2+y^2\le16.
\]
That's exactly a disk with the circular boundary \(x^2+y^2=16\), and it is within section 14.7.

The original Fall 2022, 2023, and 2024 sample exams also have circle-constrained extrema problems, all question 6. Those explicitly require Lagrange multipliers, so they were removed from your filtered copies. **HW08 #6 is the best match for your exam.**`;

  it.each(["ArrowRight", "ArrowDown"])(
    "keeps Command-%s after the closing marker in the pasted draft",
    async (key) => {
      const editor = await mountEditor(markdown);
      await act(async () => {
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
        editor.view.focus();
        expect(press(editor, "ArrowRight")).toBe(true);
        expect(press(editor, key, { metaKey: true })).toBe(true);
        expect(editor.state.selection.eq(TextSelection.atEnd(editor.state.doc))).toBe(true);
        // Force the DOM selection rewrite that used to pull the caret back.
        editor.view.updateState(editor.state);
        const markers = editor.view.dom.querySelectorAll(".composer-rich-marker");
        const closingMarker = markers[markers.length - 1];
        const caret = window.getSelection()?.getRangeAt(0);
        if (!closingMarker || !caret) throw new Error("Caret or closing marker is missing");
        const markerRange = document.createRange();
        markerRange.selectNode(closingMarker);
        expect(caret.compareBoundaryPoints(Range.START_TO_END, markerRange)).toBeGreaterThanOrEqual(
          0,
        );
        editor.commands.insertContent("x");
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe(markdown + "x");
    },
  );

  it.each(["ArrowRight", "ArrowDown"])(
    "moves Command-%s from inside bold to outside its closing marker",
    async (key) => {
      const editor = await mountEditor("**bold**");
      await act(async () => {
        editor.commands.setTextSelection(3);
        editor.view.focus();
        expect(press(editor, key, { metaKey: true })).toBe(true);
        editor.commands.insertContent("x");
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe("**bold**x");
    },
  );

  it.each(["ArrowLeft", "ArrowUp"])("moves Command-%s before the opening marker", async (key) => {
    const editor = await mountEditor("**bold**");
    await act(async () => {
      editor.commands.setTextSelection(3);
      editor.view.focus();
      expect(press(editor, key, { metaKey: true })).toBe(true);
      editor.commands.insertContent("x");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("x**bold**");
  });

  it.each(["ArrowRight", "ArrowDown"])(
    "extends Shift-Command-%s to the end without collapsing the selection",
    async (key) => {
      const editor = await mountEditor("**bold**");
      await act(async () => {
        editor.commands.setTextSelection(3);
        editor.view.focus();
        expect(press(editor, key, { metaKey: true, shiftKey: true })).toBe(true);
        expect(editor.state.selection.anchor).toBe(3);
        expect(editor.state.selection.head).toBe(TextSelection.atEnd(editor.state.doc).to);
        editor.commands.insertContent("x");
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe("**box**");
    },
  );

  it("leaves Command-arrow navigation to the browser on other platforms", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const editor = await mountEditor("**bold**");
    await act(async () => {
      editor.view.focus();
      expect(press(editor, "ArrowDown", { metaKey: true })).toBe(false);
    });
  });
});

it("leaves literal Markdown navigation to the browser in plain mode", async () => {
  const editor = await mountEditor(draft, false);
  await act(async () => {
    editor.commands.setTextSelection(5);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});
