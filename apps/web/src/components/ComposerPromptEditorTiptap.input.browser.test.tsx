import type { ComposerFileAttachment } from "../composerDraftStore";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { fileContextReference } from "../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedContextPayloads,
  useRetainedContextPayloads,
} from "./chat/composerContextUndo";

import type { ServerProviderSkill } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { createElement, createRef, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { isMacPlatform } from "~/lib/utils";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

const babysit: ServerProviderSkill = {
  name: "babysit",
  path: "/skills/babysit/SKILL.md",
  enabled: true,
};

function Composer({
  value,
  richTextEnabled,
  skills,
  onChange,
}: {
  value: string;
  richTextEnabled: boolean;
  skills: ReadonlyArray<ServerProviderSkill>;
  onChange?: ComposerPromptEditorProps["onChange"] | undefined;
}) {
  const [prompt, setPrompt] = useState({ value, cursor: value.length });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled={richTextEnabled}
      contextRecords={new Map()}
      skills={skills}
      disabled={false}
      placeholder=""
      onChange={(...args) => {
        setPrompt({ value: args[0], cursor: args[1] });
        onChange?.(...args);
      }}
      onPaste={() => {}}
    />
  );
}

function composer(
  value: string,
  richTextEnabled = true,
  skills: ReadonlyArray<ServerProviderSkill> = [],
  onChange?: ComposerPromptEditorProps["onChange"],
) {
  return (
    <Composer value={value} richTextEnabled={richTextEnabled} skills={skills} onChange={onChange} />
  );
}

function editorIn(container: HTMLElement) {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

async function mountEditor(...props: Parameters<typeof composer>) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(composer(...props)));
  const editor = editorIn(screen.container);
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    editor,
    /** Rerenders the same composer with new props, as a parent would. */
    update: async (...next: Parameters<typeof composer>) => {
      await screen.rerender(composer(...next));
      return editorIn(screen.container);
    },
  });
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

function textWithMark(editor: Editor, name: string) {
  const text: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === name)) {
      text.push(node.textContent);
    }
  });
  return text;
}

it.each([
  { value: "clean _build and node", code: [] },
  { value: "clean `_build` and `node", code: ["_build"] },
])("keeps a typed underscore literal after $value", async ({ value, code }) => {
  await using screen = await mountEditor(value);
  const { editor } = screen;
  await act(async () => {
    editor.commands.focus("end");
    const { from, to } = editor.state.selection;
    typeText(editor, from, to, "_");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(`${value}_`);
  expect(textWithMark(editor, "italic")).toEqual([]);
  expect(textWithMark(editor, "code")).toEqual(code);
});

it("bolds with Mod+B only when text is selected", async () => {
  await using screen = await mountEditor("ship it");
  const { editor } = screen;
  const modB = isMacPlatform(navigator.platform) ? "{Meta>}b{/Meta}" : "{Control>}b{/Control}";
  await act(async () => {
    editor.commands.focus("end");
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  await userEvent.keyboard(modB);
  // Without the guard, Tiptap stores bold for the next typed text.
  expect(editor.state.storedMarks).toBeNull();

  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
  });
  await userEvent.keyboard(modB);
  await vi.waitFor(() => expect(textWithMark(editor, "bold")).toEqual(["ship"]));
});

it.each([false, true])(
  "composes an umlaut without wrapping the preedit text (rich text: %s)",
  async (richTextEnabled) => {
    // The middle dot stands in for the provisional text shown by the Compose key.
    await using screen = await mountEditor("·", richTextEnabled);
    const { editor } = screen;
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

it("lets composition replace selected text without surrounding it", async () => {
  await using screen = await mountEditor("word");
  const { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    typeText(editor, 1, 5, '"');
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
});

it("keeps unknown dollar names editable when restoring and pasting a draft", async () => {
  const value = "echo $HOME $PATH $anything $notaskill $20 $20k $babysit ";
  await using screen = await mountEditor(value, true, [babysit]);
  const { editor } = screen;
  expect(editor.state.doc.textContent).toBe(value.replace("$babysit", ""));
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
  await act(async () => {
    editor.commands.setTextSelection("echo $HO".length + 1);
    editor.commands.insertContent("X");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value.replace("$HOME", "$HOXME"));
  await act(async () => {
    editor.commands.selectAll();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
  });
  expect(editor.state.doc.textContent).toBe(value.replace("$babysit", ""));
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
});

it("keeps the caret inside unknown dollar text across rich and plain remounts", async () => {
  const value = "echo $HOME now";
  await using screen = await mountEditor(value);
  let { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection("echo $HO".length + 1);
  });
  editor = await screen.update(value, false);
  await act(async () => {
    editor.commands.insertContent("X");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("echo $HOXME now");
  editor = await screen.update(value, true);
  await act(async () => {
    editor.commands.insertContent("Y");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("echo $HOXYME now");
});

const file = {
  type: "file",
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  file: new File(["notes"], "notes.txt", { type: "text/plain" }),
} satisfies ComposerFileAttachment;

describe("composer context undo lifetime", () => {
  async function mountComposer(destinationValue = "") {
    const initialValue = `Draft A ${formatInlineContextReference(fileContextReference(file))}`;
    const editorRef = createRef<ComposerPromptEditorHandle>();
    let current: { value: string; files: ComposerFileAttachment[] };
    let retained: RetainedContextPayloads;

    function Composer({ targetKey }: { targetKey: string }) {
      const [drafts, setDrafts] = useState<
        Record<string, { value: string; files: ComposerFileAttachment[] }>
      >({
        a: { value: initialValue, files: [file] },
        b: { value: destinationValue, files: [] },
      });
      const payloads = useRetainedContextPayloads(targetKey);
      const draft = drafts[targetKey]!;
      useEffect(() => {
        current = draft;
        retained = payloads;
      });
      const editorProps = {
        draftKey: targetKey,
        editorRef,
        value: draft.value,
        cursor: 0,
        contextRecords: new Map(
          draft.files.map((entry) => [
            fileContextReference(entry).contextId,
            { kind: "file" as const, record: entry },
          ]),
        ),
        skills: [],
        disabled: false,
        placeholder: "",
        onChange: (value, _cursor, _expandedCursor, _adjacent, contextIds) => {
          const changes = reconcileAttachmentContextReferences({
            referencedContextIds: new Set(contextIds),
            files: draft.files,
            images: [],
            previewAnnotations: [],
            retained: payloads,
          });
          setDrafts({
            ...drafts,
            [targetKey]: {
              value,
              files: [
                ...draft.files.filter((entry) => !changes.filesToRemove.includes(entry.id)),
                ...changes.filesToRestore,
              ],
            },
          });
        },
        onPaste: () => {},
      } satisfies ComposerPromptEditorProps;
      return createElement(ComposerPromptEditor, editorProps);
    }

    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await render(createElement(Composer, { targetKey: "a" })));
    const editor = () => editorIn(screen.container);
    const environment = stack.move();
    return Object.assign(screen, {
      [Symbol.asyncDispose]: () => environment.disposeAsync(),
      initialValue,
      show: (targetKey: string) => screen.rerender(createElement(Composer, { targetKey })),
      editor,
      draft: () => current,
      retained: () => retained,
      deleteDraft: async () => {
        await act(async () => {
          const currentEditor = editor();
          currentEditor.view.dispatch(
            currentEditor.state.tr.delete(1, currentEditor.state.doc.content.size - 1),
          );
        });
      },
      undo: async () => {
        await act(async () => {
          editor().commands.undo();
        });
      },
    });
  }

  it("restores a deleted chip and its file bytes on same-draft undo, then releases them on unmount", async () => {
    await using composer = await mountComposer();
    await composer.deleteDraft();
    expect(composer.draft()).toEqual({ value: "", files: [] });
    const retained = composer.retained();
    expect(retained.files.get(fileContextReference(file).contextId)?.file).toBe(file.file);

    await composer.show("a");
    await composer.undo();
    expect(serializeEditorDoc(composer.editor().state.doc).value).toBe(composer.initialValue);
    expect(composer.draft()).toEqual({ value: composer.initialValue, files: [file] });
    expect(composer.draft().files[0]?.file).toBe(file.file);

    await composer.deleteDraft();
    await composer.unmount();
    expect(retained.files.size).toBe(0);
  });

  it.each(["", "Draft B"])(
    "releases deleted payloads and prevents undo into the previous draft when switching to %j",
    async (destinationValue) => {
      await using composer = await mountComposer(destinationValue);
      await composer.deleteDraft();
      expect(composer.draft()).toEqual({ value: "", files: [] });
      const retained = composer.retained();
      expect(retained.files.get(fileContextReference(file).contextId)?.file).toBe(file.file);

      await composer.show("b");
      expect(retained.files.size).toBe(0);
      await composer.undo();
      expect(serializeEditorDoc(composer.editor().state.doc).value).toBe(destinationValue);
      expect(composer.draft()).toEqual({ value: destinationValue, files: [] });

      await composer.show("a");
      await composer.undo();
      expect(serializeEditorDoc(composer.editor().state.doc).value).toBe("");
      expect(composer.draft()).toEqual({ value: "", files: [] });
    },
  );
});

describe("an Arabic line", () => {
  async function focusEnd(editor: Editor) {
    // ProseMirror rewrites the DOM caret 20ms after focus. Run that now, or it
    // can undo the first arrow key before ProseMirror reads the native move.
    using _timers = fakeTimers();
    await act(async () => {
      editor.commands.focus("end");
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
    vi.runOnlyPendingTimers();
  }

  it("leaves inline code through its start with ArrowRight, which points back", async () => {
    // Positions: اكتب at 1-5, sumBy at 6-11, الان at 12-16.
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await focusEnd(editor);
    const caret = () => ({
      head: editor.state.selection.head,
      inCode: (editor.state.storedMarks ?? editor.state.selection.$head.marks()).length > 0,
    });
    const visited = [caret()];
    while (visited.at(-1)!.head > 5) {
      const before = visited.at(-1)!;
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => {
        const after = caret();
        expect(after.head < before.head || after.inCode !== before.inCode).toBe(true);
      });
      visited.push(caret());
    }
    expect(visited.some((stop) => stop.inCode)).toBe(true);
  });

  it("shows the backticks on either side of inline code it is editing", async () => {
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection("اكتب su".length + 1);
    });
    const code = editor.view.dom.querySelector("code")!;
    const word = document.createRange();
    word.selectNodeContents([...code.childNodes].find((node) => node instanceof Text)!);
    const text = word.getBoundingClientRect();
    const [open, close] = [...editor.view.dom.querySelectorAll(".composer-rich-marker")].map(
      (marker) => marker.getBoundingClientRect(),
    );
    expect(open!.right).toBeLessThanOrEqual(text.left + 1);
    expect(close!.left).toBeGreaterThanOrEqual(text.right - 1);
  });

  it("starts the next line on the right", async () => {
    await using screen = await mountEditor("اكتب الدالة");
    const { editor } = screen;
    await focusEnd(editor);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await vi.waitFor(() => expect(editor.state.doc.childCount).toBe(2));
    const box = editor.view.dom.getBoundingClientRect();
    expect(editor.view.coordsAtPos(editor.state.selection.head).left).toBeGreaterThan(
      box.left + box.width / 2,
    );
  });
});

it.each([
  { quote: "'", richTextEnabled: true, key: "Dead" },
  { quote: '"', richTextEnabled: true, key: "Dead" },
  { quote: "'", richTextEnabled: false, key: "Dead" },
  { quote: "'", richTextEnabled: true, key: "Process" },
  { quote: '"', richTextEnabled: true, key: "Process" },
])(
  "surrounds the original selection after dead-key composition: %j",
  async ({ quote, richTextEnabled, key }) => {
    await using screen = await mountEditor("before word after", richTextEnabled);
    const { editor } = screen;
    using _timers = fakeTimers();
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
  await using screen = await mountEditor("word", true);
  const { editor } = screen;
  using _timers = fakeTimers();
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
  await using screen = await mountEditor("word", true);
  const { editor } = screen;
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
  await using screen = await mountEditor("word", true);
  const { editor } = screen;
  using _timers = fakeTimers();
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
  await using screen = await mountEditor("word", true);
  const { editor } = screen;
  using _timers = fakeTimers();
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
  await using screen = await mountEditor("word", true);
  const { editor } = screen;
  using _timers = fakeTimers();
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
  await using screen = await mountEditor("word", true);
  const { editor } = screen;
  using _timers = fakeTimers();
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
  await using screen = await mountEditor("word");
  const { editor } = screen;
  using _timers = fakeTimers();
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
  await using screen = await mountEditor("word");
  const { editor } = screen;
  using _timers = fakeTimers();
  await act(async () => {
    editor.commands.setNodeSelection(0);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    dispatchComposition(editor, "compositionstart");
    typeText(editor, editor.state.selection.from, editor.state.selection.to, "'");
    await finishComposition(editor, "'");
  });
  expect(editor.state.doc.textContent).toBe("'");
});

it("surrounds a selection when a dead-key quote commits", async () => {
  await using screen = await mountEditor("word");
  const { editor } = screen;
  using _timers = fakeTimers();
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    const { from, to } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.insertText("'", from, to).setMeta("composition", 1));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "'" }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("'word'");
});
