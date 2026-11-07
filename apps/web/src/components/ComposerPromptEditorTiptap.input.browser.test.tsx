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
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { createElement, createRef, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";

import { flatToMarkdown, pmToFlat, serializeEditorDoc } from "~/composer-rich-text-doc";
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
  const insert = () => editor.state.tr.insertText(text, from, to);
  if (
    !editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, insert),
    )
  ) {
    editor.view.dispatch(insert());
  }
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

it.each([
  { word: "ship", prefix: "", source: ["**ship**"] },
  { word: "path\\", prefix: "", source: [] },
  { word: "2*3", prefix: "", source: [] },
  { word: "b", prefix: "*", source: [] },
  { word: "word", prefix: "\\\\*", source: [] },
  { word: "word", prefix: "\\\\**", source: [] },
  { word: "word", prefix: "\\", source: [] },
  { word: "word", prefix: "\\\\", source: ["**word**"] },
  { word: "word", prefix: "\\\\\\", source: [] },
  {
    word: "word",
    prefix: "`path\\`",
    prefixText: "path\\",
    source: ["**word**"],
    code: ["path\\"],
  },
])(
  "bolds $word after '$prefix' with Mod+B only when text is selected",
  async ({ word, prefix, prefixText = prefix, source, code = [] }) => {
    const value = `${prefix}${word} it`;
    await using screen = await mountEditor(value);
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
      editor.commands.setTextSelection({
        from: prefixText.length + 1,
        to: prefixText.length + word.length + 1,
      });
    });
    await userEvent.keyboard(modB);
    await vi.waitFor(() =>
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}**${word}** it`),
    );
    expect(textWithMark(editor, "markdownSource")).toEqual(source);
    const depth = undoDepth(editor.state);
    await userEvent.keyboard("{End}");
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}**${word}** it`);
    expect(textWithMark(editor, "bold")).toEqual([word]);
    expect(textWithMark(editor, "code")).toEqual(code);
    expect(undoDepth(editor.state)).toBe(depth);
    await act(async () => {
      editor.commands.setTextSelection({
        from: prefixText.length + 1,
        to: prefixText.length + word.length + 1,
      });
    });

    // Whether the selection spans shown markers or not, Mod+B removes the bold.
    await userEvent.keyboard(modB);
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(value));
  },
);

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

it.each([
  { richText: true, composing: true, text: '"', expected: '"' },
  { richText: true, composing: false, text: "*", expected: "*word*" },
  { richText: false, composing: false, text: "*", expected: "*" },
  { richText: false, composing: false, text: "_", expected: "_" },
  { richText: false, composing: false, text: "`", expected: "`" },
  { richText: false, composing: false, text: '"', expected: '"' },
  { richText: false, composing: false, text: "(", expected: "(" },
])("replaces or surrounds selected text: %j", async ({ richText, composing, text, expected }) => {
  await using screen = await mountEditor("word", richText);
  const { editor } = screen;
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    if (composing) editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    typeText(editor, 1, 5, text);
  });
  await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(expected));
});

it.each([
  { at: "inside bold", selection: 5, composed: "**bo漢ld** after", bold: ["bo漢ld"] },
  {
    at: "over the opening markers",
    selection: { from: 1, to: 3 },
    composed: "漢bold** after",
    bold: [],
  },
  { at: "after the closing markers", selection: 9, composed: "**bold**漢 after", bold: ["bold"] },
])("undoes composition $at in revealed Markdown through the earlier paste", async (row) => {
  await using screen = await mountEditor("");
  const { editor } = screen;
  const value = () => serializeEditorDoc(editor.state.doc).value;
  await act(async () => {
    editor.view.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "**bold** after");
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
    editor.commands.insertContent("!");
    editor.commands.undo();
    editor.commands.setTextSelection(3);
  });
  expect(value()).toBe("**bold** after");
  expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
  await act(async () => {
    editor.commands.setTextSelection(row.selection);
    // A composition canceled before it edits anything keeps the redo and adds no undo.
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
  });
  expect([undoDepth(editor.state), redoDepth(editor.state)]).toEqual([1, 1]);
  await act(async () => {
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    // ProseMirror numbers each composition; the canceled one was 1.
    editor.view.dispatch(editor.state.tr.insertText("漢").setMeta("composition", 2));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "漢" }));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  expect(value()).toBe(row.composed);
  await act(async () => {
    editor.commands.undo();
  });
  expect(value()).toBe("**bold** after");
  await act(async () => {
    editor.commands.undo();
  });
  expect(value()).toBe("");
  await act(async () => {
    editor.commands.redo();
    editor.commands.redo();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  });
  expect(value()).toBe(row.composed);
  expect(textWithMark(editor, "bold")).toEqual(row.bold);
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

async function focusAt(editor: Editor, position: number | "end") {
  // ProseMirror rewrites the DOM caret 20ms after focus. Run that now, or it
  // can undo the first key before ProseMirror reads the native move.
  using _timers = fakeTimers();
  await act(async () => {
    editor.commands.focus(position);
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  vi.runOnlyPendingTimers();
}

describe("Markdown markers around styled text", () => {
  it.each([
    { keys: "{Backspace}", expected: "**** after" },
    { keys: "X", expected: "**X** after" },
  ])("keeps a styled chip selected for $keys when showing source", async ({ keys, expected }) => {
    await using screen = await mountEditor("$babysit after", true, [babysit]);
    const { editor } = screen;
    await focusAt(editor, "end");
    await act(async () => {
      editor.view.dispatch(editor.state.tr.addMark(1, 2, editor.schema.marks.bold!.create()));
    });
    expect(editor.state.doc.nodeAt(1)?.type.name).toBe("composer-skill");
    await act(async () => {
      editor.commands.setNodeSelection(1);
    });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("composer-skill");
    await userEvent.keyboard(keys);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(expected));
  });

  it.each([
    {
      name: "deleting the opening markers removes bold",
      value: "**bold** after",
      caret: 1,
      keys: "{Delete}{Delete}",
      expected: "bold** after",
      marks: {},
    },
    {
      name: "turning ** into * makes it italic",
      value: "**bold** after",
      caret: 1,
      keys: "{Delete}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Delete}",
      expected: "*bold* after",
      marks: { italic: ["bold"] },
    },
    {
      name: "backspacing from the closing edge keeps italic",
      value: "**bold** after",
      caret: 1,
      keys: async (editor: Editor) => {
        await userEvent.keyboard("{Delete}");
        await vi.waitFor(() => expect(editor.state.doc.textContent).toBe("*bold** after"));
        for (let position = 2; position <= 8; position += 1) {
          await userEvent.keyboard("{ArrowRight}");
          await vi.waitFor(() => expect(editor.state.selection.from).toBe(position));
        }
        await userEvent.keyboard("{Backspace}");
        await vi.waitFor(() =>
          expect(serializeEditorDoc(editor.state.doc).value).toBe("*bold* after"),
        );
      },
      expected: "*bold* after",
      marks: { italic: ["bold"] },
    },
    {
      name: "retyping deleted closing markers restores bold",
      value: "**bold** after",
      caret: 3,
      keys: "{ArrowRight}{ArrowRight}{Delete}{Delete}**",
      expected: "**bold** after",
      marks: { bold: ["bold"] },
    },
    {
      name: "deleting a backtick removes inline code",
      value: "`code` after",
      caret: 1,
      keys: "{Delete}",
      expected: "code` after",
      marks: {},
    },
    {
      name: "a line break inside bold keeps both halves bold",
      value: "**bold** after",
      caret: 3,
      keys: "{Shift>}{Enter}{/Shift}",
      expected: "**bo**\n**ld** after",
      marks: { bold: ["bo", "ld"] },
    },
    {
      name: "splitting a list item inside bold keeps both halves bold",
      value: "- **bold** after",
      caret: 5,
      keys: "{Enter}",
      expected: "- **bo**\n- **ld** after",
      marks: { bold: ["bo", "ld"] },
    },
  ])("edits the markers as text: $name", async ({ value, caret, keys, expected, marks }) => {
    await using screen = await mountEditor(value);
    const { editor } = screen;
    // Position 1 is the start of the styled word; 3 is two characters into it (5 in a list item).
    await focusAt(editor, caret);
    if (typeof keys === "string") await userEvent.keyboard(keys);
    else await keys(editor);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe(expected));
    for (const name of ["bold", "italic", "code"] as const) {
      expect(textWithMark(editor, name)).toEqual(marks[name as keyof typeof marks] ?? []);
    }
  });

  it("shows nested formatting as Markdown and restores it when the caret leaves", async () => {
    const value = "**a *b* c** d";
    await using screen = await mountEditor(value);
    const { editor } = screen;
    await focusAt(editor, "a b".length + 1);
    expect(editor.state.doc.textContent).toBe(value);
    expect(textWithMark(editor, "bold")).toEqual([]);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(editor.state.doc.textContent).toBe("a b c d"));
    expect(textWithMark(editor, "bold")).toEqual(["a ", "b", " c"]);
    expect(textWithMark(editor, "italic")).toEqual(["b"]);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
  });

  it("undoes a marker edit in one step without an extra step for showing markers", async () => {
    await using screen = await mountEditor("**bold** after");
    const { editor } = screen;
    await focusAt(editor, "end");
    await userEvent.keyboard("!");
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    await userEvent.keyboard("{Delete}{Delete}{End}");
    const value = () => serializeEditorDoc(editor.state.doc).value;
    await vi.waitFor(() => expect(value()).toBe("bold** after!"));
    await act(async () => {
      editor.commands.undo();
    });
    expect(value()).toBe("**bold** after!");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    const end = () => editor.state.doc.content.size - 1;
    // Undo restored the markers as text; leaving hides them without touching the text undo needs.
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(value()).toBe("**bold** after!");
    const hidden = editor.view.dom.querySelectorAll(".composer-rich-marker-hidden");
    expect(Array.from(hidden, (marker) => marker.textContent)).toEqual(["**", "**"]);
    await act(async () => {
      editor.commands.undo();
    });
    expect(value()).toBe("**bold** after");
    // Moving the caret into styled text keeps redo, and adds no undo step after it.
    await act(async () => {
      editor.commands.setTextSelection(3);
    });
    expect(editor.state.doc.textContent).toBe("**bold** after");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    await act(async () => {
      editor.commands.redo();
    });
    expect(value()).toBe("**bold** after!");
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    await act(async () => {
      editor.commands.redo();
    });
    expect(value()).toBe("bold** after!");
    expect(textWithMark(editor, "bold")).toEqual([]);
    await act(async () => {
      editor.commands.undo();
      editor.commands.undo();
    });
    await act(async () => {
      editor.commands.redo();
    });
    await act(async () => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    await act(async () => {
      editor.commands.undo();
    });
    // Undo puts the caret back inside the styled text.
    expect(editor.state.doc.textContent).toBe("**bold** after");
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(editor.state.doc.textContent).toBe("bold after");
    expect(textWithMark(editor, "bold")).toEqual(["bold"]);
    // After a completed redo, markers still follow the caret, and Delete edits the opening one.
    await userEvent.keyboard("?");
    await act(async () => {
      editor.commands.undo();
    });
    await act(async () => {
      editor.commands.redo();
    });
    expect(editor.state.doc.textContent).toBe("bold after?");
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    expect(editor.state.doc.textContent).toBe("**bold** after?");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(editor.state.doc.textContent).toBe("bold after?");
    expect(textWithMark(editor, "bold")).toEqual(["bold"]);
    await act(async () => {
      editor.commands.setTextSelection(1);
    });
    await userEvent.keyboard("{Delete}");
    expect(value()).toBe("*bold** after?");
    await act(async () => {
      editor.commands.undo();
    });
    expect(value()).toBe("**bold** after?");
    expect(textWithMark(editor, "markdownSource")).toEqual(["**bold**"]);
    await act(async () => {
      editor.commands.setTextSelection(end());
    });
    expect(editor.state.doc.textContent).toBe("bold after?");
    expect(textWithMark(editor, "bold")).toEqual(["bold"]);
  });

  it("keeps bold around a skill pasted inside it", async () => {
    await using screen = await mountEditor("**helloworld** after", true, [babysit]);
    const { editor } = screen;
    await focusAt(editor, "hello".length + 1);
    await act(async () => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "$babysit");
      editor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, cancelable: true }),
      );
    });
    await userEvent.keyboard("{End}");
    await vi.waitFor(() =>
      expect(serializeEditorDoc(editor.state.doc).value).toBe("**hello** $babysit **world** after"),
    );
    expect(textWithMark(editor, "bold")).toEqual(["hello", "world"]);
  });
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

  it("walks back through inline code and its backticks with ArrowRight", async () => {
    const value = "اكتب `sumBy` الان";
    await using screen = await mountEditor(value);
    const { editor } = screen;
    await focusEnd(editor);
    const offset = () => {
      const map = serializeEditorDoc(editor.state.doc);
      return flatToMarkdown(map, pmToFlat(map, editor.state.selection.head));
    };
    const visited = [offset()];
    let sawSource = false;
    while (visited.at(-1)! > "اكتب".length) {
      const before = visited.at(-1)!;
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => expect(offset()).toBe(before - 1));
      sawSource ||= editor.state.doc.textContent === value;
      visited.push(offset());
    }
    expect(sawSource).toBe(true);
    expect(textWithMark(editor, "code")).toEqual(["sumBy"]);
  });

  it("shows the backticks on either side of inline code it is editing", async () => {
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection("اكتب su".length + 1);
    });
    const code = editor.view.dom.querySelector("code")!;
    const text = [...code.childNodes].find((node) => node instanceof Text)!;
    expect(text.data).toBe("`sumBy`");
    const rect = (from: number, to: number) => {
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, to);
      return range.getBoundingClientRect();
    };
    const [open, word, close] = [rect(0, 1), rect(1, 6), rect(6, 7)];
    expect(open.right).toBeLessThanOrEqual(word.left + 1);
    expect(close.left).toBeGreaterThanOrEqual(word.right - 1);
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
