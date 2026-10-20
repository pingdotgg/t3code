import type { Editor } from "@tiptap/core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mountEditor(value: string, richTextEnabled = true) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={value.length}
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

async function replaceDomText(editor: Editor, text: string, isComposing = false) {
  await act(async () => {
    const node = editor.view.dom.querySelector("p")?.firstChild;
    if (!(node instanceof Text)) throw new Error("Composition text is missing");
    node.data = text;
    window.getSelection()?.collapse(node, text.length);
    if (isComposing) {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionupdate", { data: text }));
    }
    editor.view.dom.dispatchEvent(
      new InputEvent("input", {
        inputType: isComposing ? "insertCompositionText" : "insertText",
        data: text,
        isComposing,
      }),
    );
  });
}

function typeText(editor: Editor, from: number, to: number, text: string) {
  const insert = () => {
    const tr = editor.state.tr.insertText(text, from, to);
    return editor.view.composing ? tr.setMeta("composition", 1) : tr;
  };
  if (
    !editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, insert),
    )
  ) {
    editor.view.dispatch(insert());
  }
}

function dispatchComposition(
  editor: Editor,
  type: "compositionstart" | "compositionend",
  data = "",
) {
  editor.view.dom.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
}

async function finishComposition(editor: Editor, text: string) {
  dispatchComposition(editor, "compositionend", text);
  await vi.advanceTimersByTimeAsync(0);
}

it.each([false, true])(
  "composes an umlaut without wrapping the preedit text (rich text: %s)",
  async (richTextEnabled) => {
    // The middle dot stands in for the provisional text shown by the Compose key.
    const editor = await mountEditor("·", richTextEnabled);
    await act(async () => {
      editor.view.focus();
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    });
    await replaceDomText(editor, '"', true);
    expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
    await replaceDomText(editor, "ö", true);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "ö" }));
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("ö");
  },
);

it("commits a composed quote without surrounding the preedit text", async () => {
  const editor = await mountEditor("·");
  await act(async () => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: '"' }));
  });
  await replaceDomText(editor, '"');
  expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
});

it("lets composition replace selected text without surrounding it", async () => {
  const editor = await mountEditor("word");
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    typeText(editor, 1, 5, '"');
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
});

it("replaces text outside the selected range without surrounding it", async () => {
  const editor = await mountEditor("word");
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    typeText(editor, 2, 3, '"');
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe('w"rd');
});

it.each([false, true])(
  "still surrounds selected text with quotes (rich text: %s)",
  async (richTextEnabled) => {
    const editor = await mountEditor("word", richTextEnabled);
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      editor.view.focus();
    });
    await replaceDomText(editor, '"');
    expect(serializeEditorDoc(editor.state.doc).value).toBe('"word"');
  },
);

it.each([
  { quote: "'", richTextEnabled: true, key: "Dead" },
  { quote: '"', richTextEnabled: true, key: "Dead" },
  { quote: "'", richTextEnabled: false, key: "Dead" },
  { quote: "'", richTextEnabled: true, key: "Process" },
  { quote: '"', richTextEnabled: true, key: "Process" },
])(
  "surrounds the original selection after dead-key composition: %j",
  async ({ quote, richTextEnabled, key }) => {
    const editor = await mountEditor("before word after", richTextEnabled);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      editor.commands.setTextSelection({ from: 8, to: 12 });
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: "Quote",
          keyCode: key === "Process" ? 229 : 222,
          bubbles: true,
        }),
      );
      expect(editor.state.selection.empty).toBe(true);
      dispatchComposition(editor, "compositionstart", "word");
      editor.view.dispatch(
        editor.state.tr.insertText(quote === "'" ? "´" : "¨").setMeta("composition", 1),
      );
      expect(editor.state.doc.textContent).toBe(`before ${quote === "'" ? "´" : "¨"}word after`);
      typeText(editor, 8, 9, quote);
      expect(editor.state.doc.textContent).toBe(`before ${quote}word after`);
      await finishComposition(editor, quote);
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`before ${quote}word${quote} after`);
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to),
    ).toBe("word");
    await act(async () => {
      editor.commands.undo();
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("before word after");
    await act(async () => {
      editor.commands.redo();
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`before ${quote}word${quote} after`);
  },
);

it("lets an accented letter replace the selection", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    dispatchComposition(editor, "compositionstart");
    editor.view.dispatch(editor.state.tr.insertText("´").setMeta("composition", 1));
    typeText(editor, 1, 2, "é");
    await finishComposition(editor, "é");
    typeText(editor, 2, 2, "'");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("é'");
  expect(editor.state.selection.empty).toBe(true);
});

it.each([
  { text: "'", expected: "'word'", selected: "word" },
  { text: '"', expected: '"word"', selected: "word" },
  { text: "é", expected: "é", selected: "" },
])("resolves dead keys without composition events: %j", async ({ text, expected, selected }) => {
  const editor = await mountEditor("word", true);
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Dead", code: "Quote", bubbles: true }),
    );
    typeText(editor, 1, 1, text);
  });
  expect(editor.state.doc.textContent).toBe(expected);
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe(
    selected,
  );
  await act(async () => {
    editor.commands.undo();
  });
  expect(editor.state.doc.textContent).toBe("word");
});

it("does not restore a composition selection after the draft is replaced", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    dispatchComposition(editor, "compositionstart");
    editor.view.dispatch(editor.state.tr.insertText("'").setMeta("composition", 1));
    dispatchComposition(editor, "compositionend", "'");
    editor.commands.setContent("new draft");
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("new draft");
});

it("keeps the original selection when dead-key composition is cancelled", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    dispatchComposition(editor, "compositionstart");
    editor.view.dispatch(editor.state.tr.insertText("´").setMeta("composition", 1));
    typeText(editor, 1, 2, "");
    await finishComposition(editor, "");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("word");
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(5);
});

it("leaves other input methods free to replace selected text during composition", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    dispatchComposition(editor, "compositionstart");
    editor.view.dispatch(editor.state.tr.insertText("字").setMeta("composition", 1));
    expect(editor.state.doc.textContent).toBe("字");
    await finishComposition(editor, "字");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("字");
});

it("keeps select-all text in place while a dead key resolves", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.selectAll();
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    dispatchComposition(editor, "compositionstart");
    expect(editor.state.selection.from).toBe(1);
    editor.view.dispatch(editor.state.tr.insertText("´").setMeta("composition", 1));
    expect(editor.state.doc.textContent).toBe("´word");
    typeText(editor, 1, 2, "'");
    await finishComposition(editor, "'");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("'word'");
});

it("does not reuse a dead-key selection after the caret moves away and back", async () => {
  const editor = await mountEditor("word");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    editor.commands.setTextSelection(5);
    editor.commands.setTextSelection(1);
    dispatchComposition(editor, "compositionstart");
    typeText(editor, 1, 1, "'");
    await finishComposition(editor, "'");
  });
  expect(editor.state.doc.textContent).toBe("'word");
  expect(editor.state.selection.empty).toBe(true);
});

it("lets a dead key replace a selected node", async () => {
  const editor = await mountEditor("word");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setNodeSelection(0);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    dispatchComposition(editor, "compositionstart");
    typeText(editor, editor.state.selection.from, editor.state.selection.to, "'");
    await finishComposition(editor, "'");
  });
  expect(editor.state.doc.textContent).toBe("'");
});
