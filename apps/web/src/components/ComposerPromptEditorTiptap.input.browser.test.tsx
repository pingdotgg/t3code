import "~/index.css";

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

async function replaceDomText(editor: Editor, text: string, isComposing = false, selector = "p") {
  await act(async () => {
    const node = editor.view.dom.querySelector(selector)?.firstChild;
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
  const tags: Record<string, string> = { bold: "strong", italic: "em", code: "code" };
  return [...editor.view.dom.querySelectorAll<HTMLElement>(tags[name]!)]
    .map((node) => (name === "code" ? node.innerText.replace(/^`|`$/g, "") : node.innerText))
    .filter(Boolean);
}

it.each([
  { value: "clean _build and node", code: [], cursor: undefined, input: "_" },
  { value: "clean `_build` and `node", code: ["_build"], cursor: undefined, input: "_" },
  {
    value: "clean `code ` now",
    code: ["code __init__"],
    cursor: { folded: 11, source: 13 },
    input: "__init__",
  },
])("keeps a typed underscore literal after $value", async ({ value, code, cursor, input }) => {
  await using screen = await mountEditor(value);
  const { editor } = screen;
  await act(async () => {
    editor.commands.focus("end");
    if (cursor !== undefined) {
      editor.commands.setTextSelection(cursor.folded);
      editor.commands.setTextSelection(cursor.source);
    }
    const { from, to } = editor.state.selection;
    typeText(editor, from, to, input);
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(
    cursor === undefined ? `${value}${input}` : "clean `code __init__` now",
  );
  expect(textWithMark(editor, "italic")).toEqual([]);
  expect(textWithMark(editor, "code")).toEqual(code);
});

it.each([false, true])(
  "bolds selected text and preserves its direction (backward: %s)",
  async (backward) => {
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
      editor.commands.setTextSelection(backward ? { from: 5, to: 1 } : { from: 1, to: 5 });
    });
    await userEvent.keyboard(modB);
    await vi.waitFor(() => expect(textWithMark(editor, "bold")).toEqual(["ship"]));
    const { from, to, anchor, head } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe("ship");
    expect(anchor > head).toBe(backward);
    await userEvent.keyboard("x");
    expect(serializeEditorDoc(editor.state.doc).value).toBe("**x** it");
    await act(async () => {
      expect(editor.commands.undo()).toBe(true);
    });
    await act(async () => {
      editor.commands.setTextSelection(3);
      editor.commands.setTextSelection({ from: 3, to: 7 });
    });
    await userEvent.keyboard(modB);
    expect(serializeEditorDoc(editor.state.doc).value).toBe("ship it");
  },
);

it.each([
  { richTextEnabled: false, value: "·", selector: "p", markers: "" },
  { richTextEnabled: true, value: "·", selector: "p", markers: "" },
  { richTextEnabled: true, value: "**·**", selector: "strong", markers: "**" },
])(
  "composes an umlaut without wrapping the preedit text in $value (rich text: $richTextEnabled)",
  async ({ richTextEnabled, value, selector, markers }) => {
    // The middle dot stands in for the provisional text shown by the Compose key.
    await using screen = await mountEditor(value, richTextEnabled);
    const { editor } = screen;
    await act(async () => {
      editor.view.focus();
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    });
    await replaceDomText(editor, '"', true, selector);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`${markers}"${markers}`);
    await replaceDomText(editor, "ö", true, selector);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "ö" }));
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`${markers}ö${markers}`);
  },
);

it.each([
  { value: "word", composing: true, from: 1, to: 5, input: '"', expected: '"' },
  { value: "word", composing: false, from: 1, to: 5, input: "(", expected: "(word)" },
  { value: "**word**", composing: false, from: 3, to: 7, input: "(", expected: "**(**" },
])(
  "replaces selected text without surrounding it in $value",
  async ({ value, composing, from, to, input, expected }) => {
    await using screen = await mountEditor(value);
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection({ from, to });
      if (composing) editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
      typeText(editor, from, to, input);
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(expected);
  },
);

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

  it("steps through each backtick of inline code with ArrowRight, which points back", async () => {
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await focusEnd(editor);
    const offset = () => {
      const map = serializeEditorDoc(editor.state.doc);
      return flatToMarkdown(map, pmToFlat(map, editor.state.selection.head));
    };
    const visited = [offset()];
    while (visited.at(-1)! > "اكتب ".length) {
      const before = visited.at(-1)!;
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => expect(offset()).toBeLessThan(before));
      visited.push(offset());
    }
    expect(visited).toEqual(Array.from({ length: 13 }, (_, index) => 17 - index));
  });

  it("keeps the backticks of inline code it is editing on either side of the code", async () => {
    await using screen = await mountEditor("اكتب `sumBy` الان");
    const { editor } = screen;
    await act(async () => {
      editor.commands.setTextSelection("اكتب su".length + 1);
    });
    const code = editor.view.dom.querySelector("code")!;
    expect(code.textContent).toBe("`sumBy`");
    const charRect = (index: number) => {
      const range = document.createRange();
      range.setStart(code.firstChild!, index);
      range.setEnd(code.firstChild!, index + 1);
      return range.getBoundingClientRect();
    };
    expect(charRect(0).right).toBeLessThanOrEqual(charRect(1).left + 1);
    expect(charRect(6).left).toBeGreaterThanOrEqual(charRect(5).right - 1);
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

describe("Markdown markers", () => {
  async function caretAt(editor: Editor, position: number) {
    await act(async () => {
      editor.commands.setTextSelection(position);
    });
  }

  async function focus(editor: Editor) {
    // ProseMirror rewrites the DOM caret 20ms after focus; run that before typing.
    using _timers = fakeTimers();
    await act(async () => {
      editor.commands.focus();
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
    vi.runOnlyPendingTimers();
  }

  async function backspaceAt(editor: Editor, position: number, expected: string) {
    await caretAt(editor, position);
    await userEvent.keyboard("{Backspace}");
    await vi.waitFor(() => expect(editor.view.dom.querySelector("p")!.textContent).toBe(expected));
  }

  it("edits the markers of styled text as text, and styles the result on leaving", async () => {
    const onChange = vi.fn<ComposerPromptEditorProps["onChange"]>();
    await using screen = await mountEditor("say **bold** now", true, [], onChange);
    const { editor } = screen;
    const paragraph = () => editor.view.dom.querySelector("p")!;
    await focus(editor);
    // "say " is 1-5 and "bold" 5-9 until the caret enters it.
    await caretAt(editor, 7);
    expect(paragraph().textContent).toBe("say **bold** now");
    expect(
      [...paragraph().querySelectorAll(".composer-rich-marker")].map(
        (marker) => marker.textContent,
      ),
    ).toEqual(["**", "**"]);
    await backspaceAt(editor, 6, "say *bold** now");
    await backspaceAt(editor, "say *bold**".length + 1, "say *bold* now");
    expect(onChange.mock.lastCall?.[0]).toBe("say *bold* now");

    await caretAt(editor, 1);
    expect(paragraph().querySelector("em")?.textContent).toBe("bold");
    expect(paragraph().innerText).toBe("say bold now");
    expect(serializeEditorDoc(editor.state.doc).value).toBe("say *bold* now");

    await act(async () => {
      editor.commands.undo();
      editor.commands.undo();
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("say **bold** now");
  });

  it.each([
    { value: "a`b", from: 1, to: 4, expected: "``a`b``", code: "``a`b``" },
    { value: "`foo", from: 1, to: 5, expected: "`` `foo ``", code: "`` `foo ``" },
    { value: "foo`", from: 1, to: 5, expected: "`` foo` ``", code: "`` foo` ``" },
    { value: "`", from: 1, to: 2, expected: "`` ` ``", code: "`` ` ``" },
    { value: "**foo***", from: 8, to: 9, expected: "**foo**`*`", code: "`*`" },
    { value: "**`*foo*`**", from: 4, to: 9, expected: "***foo***", code: null },
  ])(
    "preserves literal characters when toggling code in $value",
    async ({ value, from, to, expected, code }) => {
      await using screen = await mountEditor(value);
      const { editor } = screen;
      await focus(editor);
      await act(async () => {
        editor.commands.setTextSelection({ from, to });
      });
      const modE = isMacPlatform(navigator.platform) ? "{Meta>}e{/Meta}" : "{Control>}e{/Control}";
      await userEvent.keyboard(modE);
      expect(serializeEditorDoc(editor.state.doc).value).toBe(expected);
      expect(editor.view.dom.querySelector("code")?.textContent ?? null).toBe(code);
    },
  );

  it("drops the styling when its markers are deleted", async () => {
    await using screen = await mountEditor("say `code` now");
    const { editor } = screen;
    await focus(editor);
    await caretAt(editor, 7);
    expect(editor.view.dom.querySelector("p")!.textContent).toBe("say `code` now");
    await backspaceAt(editor, 6, "say code` now");
    await backspaceAt(editor, "say code`".length + 1, "say code now");
    await caretAt(editor, 1);
    expect(editor.view.dom.querySelector("p")!.innerHTML).toBe("say code now");
    expect(serializeEditorDoc(editor.state.doc).value).toBe("say code now");
  });

  it("undoes typed styling back through the text that was typed", async () => {
    const onChange = vi.fn<ComposerPromptEditorProps["onChange"]>();
    await using screen = await mountEditor("say ", true, [], onChange);
    const { editor } = screen;
    await focus(editor);
    await caretAt(editor, 5);
    await userEvent.keyboard("**bold**");
    await vi.waitFor(() => expect(serializeEditorDoc(editor.state.doc).value).toBe("say **bold**"));
    const typed = new Set(onChange.mock.calls.map(([value]) => value));
    const undone: string[] = [];
    while (serializeEditorDoc(editor.state.doc).value !== "say ") {
      await act(async () => {
        expect(editor.commands.undo()).toBe(true);
      });
      undone.push(serializeEditorDoc(editor.state.doc).value);
    }
    expect(undone.filter((value) => value !== "say " && !typed.has(value))).toEqual([]);
  });

  it("styles text typed between markers whose text was deleted", async () => {
    await using screen = await mountEditor("say **bold** now");
    const { editor } = screen;
    const paragraph = () => editor.view.dom.querySelector("p")!;
    await focus(editor);
    await caretAt(editor, 7);
    await backspaceAt(editor, 11, "say **bol** now");
    for (const text of ["say **bo** now", "say **b** now", "say **** now"]) {
      await userEvent.keyboard("{Backspace}");
      await vi.waitFor(() => expect(paragraph().textContent).toBe(text));
    }
    await userEvent.keyboard("new");
    await vi.waitFor(() => expect(paragraph().textContent).toBe("say **new** now"));
    await caretAt(editor, 1);
    expect(paragraph().querySelector("strong")?.textContent).toBe("new");
    expect(paragraph().innerText).toBe("say new now");
  });

  it.each([
    "undo after leaving",
    "redo after leaving",
    "undo a folding space",
    "repeated entry",
    "pending redo re-entry",
  ])("preserves styled text through %s", async (scenario) => {
    await using screen = await mountEditor("say **bold** now");
    const { editor } = screen;
    await focus(editor);
    await caretAt(editor, 9);
    if (scenario === "undo a folding space") {
      await caretAt(editor, 13);
      await userEvent.keyboard(" ");
    } else if (scenario === "pending redo re-entry") {
      await userEvent.keyboard("x");
    } else if (scenario === "redo after leaving") {
      await userEvent.keyboard(" x");
    } else {
      await backspaceAt(editor, 9, "say **bld** now");
    }
    if (scenario === "redo after leaving") {
      await act(async () => {
        expect(editor.commands.undo()).toBe(true);
      });
    }
    await caretAt(editor, 1);
    if (scenario === "pending redo re-entry") {
      await userEvent.keyboard("y");
      await act(async () => {
        expect(editor.commands.undo()).toBe(true);
      });
      await caretAt(editor, 9);
    }
    if (scenario === "repeated entry") {
      await caretAt(editor, 9);
      await userEvent.keyboard("x");
      await caretAt(editor, 1);
    }
    await act(async () => {
      expect(
        scenario === "redo after leaving" ? editor.commands.redo() : editor.commands.undo(),
      ).toBe(true);
      if (scenario === "repeated entry") expect(editor.commands.undo()).toBe(true);
    });
    const expected = scenario === "redo after leaving" ? "say **bo xld** now" : "say **bold** now";
    expect(serializeEditorDoc(editor.state.doc).value).toBe(expected);
    expect(editor.view.dom.querySelector("strong")?.textContent).toBe(
      scenario === "redo after leaving" ? "bo xld" : "bold",
    );
    await caretAt(editor, 1);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(expected);
    expect(editor.view.dom.querySelector("strong")?.textContent).toBe(
      scenario === "redo after leaving" ? "bo xld" : "bold",
    );
    if (scenario === "pending redo re-entry") {
      await act(async () => {
        expect(editor.commands.redo()).toBe(true);
      });
      expect(serializeEditorDoc(editor.state.doc).value).toBe("say **boxld** now");
    }
    if (scenario === "repeated entry") {
      for (const value of ["say **bld** now", "say **blxd** now"]) {
        await act(async () => {
          expect(editor.commands.redo()).toBe(true);
        });
        expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
        await caretAt(editor, 1);
        expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
      }
    }
  });

  it.each(["a **b *c* d** e", "a **😀 *c* d** e"])(
    "keeps %s unchanged while the caret moves in and out of styled text",
    async (value) => {
      const onChange = vi.fn<ComposerPromptEditorProps["onChange"]>();
      await using screen = await mountEditor(value, true, [], onChange);
      const { editor } = screen;
      const doc = editor.state.doc;
      for (const position of [5, 1, 4, 7, 12, 1]) await caretAt(editor, position);
      expect(editor.state.doc).toBe(doc);
      expect(onChange).toHaveBeenCalled();
      expect(new Set(onChange.mock.calls.map(([value]) => value))).toEqual(new Set([value]));
      expect(editor.view.dom.querySelector("p")!.innerText).toBe(value.replaceAll("*", ""));
    },
  );
});
