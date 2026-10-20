import type { ComposerFileAttachment } from "../composerDraftStore";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { fileContextReference } from "../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedContextPayloads,
  useRetainedContextPayloads,
} from "./chat/composerContextUndo";

import { userEvent } from "vite-plus/test/browser";
import type { ServerProviderSkill } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { act, createElement, createRef, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { detectComposerTrigger } from "~/composer-logic";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditor";

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
  vi.unstubAllGlobals();
});

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

async function mountEditor(
  value: string,
  richTextEnabled = true,
  skills: ReadonlyArray<ServerProviderSkill> = [],
  onChange?: ComposerPromptEditorProps["onChange"],
) {
  await act(async () =>
    root.render(
      <Composer
        value={value}
        richTextEnabled={richTextEnabled}
        skills={skills}
        onChange={onChange}
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
  const editor = await mountEditor(value);
  await act(async () => {
    editor.commands.focus("end");
    const { from, to } = editor.state.selection;
    typeText(editor, from, to, "_");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(`${value}_`);
  expect(textWithMark(editor, "italic")).toEqual([]);
  expect(textWithMark(editor, "code")).toEqual(code);
});

it("still italicizes text when typing a closing asterisk", async () => {
  const editor = await mountEditor("clean *build");
  await act(async () => {
    editor.commands.focus("end");
    const { from, to } = editor.state.selection;
    typeText(editor, from, to, "*");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("clean *build*");
  expect(textWithMark(editor, "italic")).toEqual(["build"]);
});

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

it("keeps unknown dollar names editable when restoring and pasting a draft", async () => {
  const value = "echo $HOME $PATH $anything $notaskill $20 $20k $babysit ";
  const editor = await mountEditor(value, true, [babysit]);
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

it("keeps skill queries active before whitespace and line breaks, suppressing only real chips", async () => {
  const onChange = vi.fn<ComposerPromptEditorProps["onChange"]>();
  const editor = await mountEditor("use  now\nfirst \n$babysit tail", true, [babysit], onChange);
  const trigger = () => {
    const [value, , expandedCursor, suppressTrigger] = onChange.mock.lastCall!;
    return suppressTrigger ? null : detectComposerTrigger(value, expandedCursor);
  };
  await act(async () => {
    editor.commands.setTextSelection("use ".length + 1);
    typeText(editor, editor.state.selection.from, editor.state.selection.to, "$bab");
  });
  expect.soft(trigger()).toMatchObject({ kind: "skill", query: "bab" });
  await act(async () => {
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1 + "first ".length);
    typeText(editor, editor.state.selection.from, editor.state.selection.to, "$bab");
  });
  expect.soft(trigger()).toMatchObject({ kind: "skill", query: "bab" });
  await act(async () => {
    editor.commands.setHardBreak();
  });
  await act(async () => {
    editor.commands.setTextSelection(editor.state.selection.from - 1);
  });
  expect(editor.state.selection.$from.nodeAfter?.type.name).toBe("hardBreak");
  expect.soft(trigger()).toMatchObject({ kind: "skill", query: "bab" });

  const chip = serializeEditorDoc(editor.state.doc).runs.find((run) => run.kind === "token")!;
  await act(async () => {
    editor.commands.setTextSelection(chip.pmPos);
  });
  expect(onChange.mock.lastCall![3]).toBe(true);
  await act(async () => {
    editor.commands.setTextSelection(chip.pmPos + 1);
  });
  expect(onChange.mock.lastCall![3]).toBe(true);
  expect(trigger()).toBeNull();
});

it("keeps the caret inside unknown dollar text across rich and plain remounts", async () => {
  const value = "echo $HOME now";
  let editor = await mountEditor(value);
  await act(async () => {
    editor.commands.setTextSelection("echo $HO".length + 1);
  });
  editor = await mountEditor(value, false);
  await act(async () => {
    editor.commands.insertContent("X");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("echo $HOXME now");
  editor = await mountEditor(value, true);
  await act(async () => {
    editor.commands.insertContent("Y");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("echo $HOXYME now");
});

it("reconciles provider skills and metadata without losing formatting, caret, or undo", async () => {
  const value = "run **use $babysit now** then $HOME";
  const disabled = { ...babysit, enabled: false };
  const agentOnly = { ...babysit, userInvocable: false };
  const editor = await mountEditor(value, true, [disabled]);
  expect.soft(editor.state.doc.textContent).toBe("run use $babysit now then $HOME");
  await mountEditor(value, true, [agentOnly]);
  expect.soft(editor.state.doc.textContent).toBe("run use $babysit now then $HOME");
  await act(async () => {
    editor.commands.setTextSelection("run use $baby".length + 1);
  });
  await mountEditor(value, true, [disabled, babysit]);
  expect(editor.state.doc.textContent).toBe("run use  now then $HOME");
  const chip = serializeEditorDoc(editor.state.doc).runs.find((run) => run.kind === "token")!;
  expect(editor.state.selection.from).toBe(chip.pmPos + 1);
  await mountEditor(value, true, [disabled]);
  expect.soft(editor.state.doc.textContent).toBe("run use $babysit now then $HOME");
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
  await act(async () => {
    editor.commands.insertContent("X");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value.replace("$babysit", "$babysitX"));
  await act(async () => {
    editor.commands.undo();
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
  expect(editor.state.doc.textContent).toBe("run use $babysit now then $HOME");

  await mountEditor(value, true, [babysit]);
  await act(async () => {
    editor.commands.deleteRange({ from: chip.pmPos, to: chip.pmPos + 1 });
  });
  await mountEditor(value, true, [agentOnly]);
  await act(async () => {
    editor.commands.undo();
  });
  expect(editor.state.doc.textContent).toBe("run use $babysit now then $HOME");
  expect(serializeEditorDoc(editor.state.doc).value).toBe(value);

  await mountEditor(value, true, [{ ...babysit, description: "Previous provider description" }]);
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Skill Babysit. Show details"]')!
      .click();
  });
  expect(document.body.textContent).toContain("Previous provider description");
  await mountEditor(value, true, [
    { ...disabled, displayName: "Disabled Babysit" },
    {
      ...babysit,
      displayName: "Current Babysit",
      shortDescription: "  Current short description  ",
    },
  ]);
  expect(container.textContent).toContain("Current Babysit");
  expect(document.body.textContent).toContain("Current short description");
  expect(document.body.textContent).not.toContain("Previous provider description");
  await mountEditor(value, true, [{ ...babysit, displayName: "Current Babysit" }]);
  expect(container.textContent).toContain("Current Babysit");
  expect(document.body.textContent).not.toContain("Current short description");
  expect(document.body.textContent).toContain("No description is available for this skill.");
  expect(document.body.textContent).not.toContain("Previous provider description");
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

    const render = async (targetKey: string) => {
      await act(async () => root.render(createElement(Composer, { targetKey })));
    };
    const editor = () => {
      const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
      if (!element) throw new Error("Composer did not mount");
      return element.editor;
    };
    await render("a");
    return {
      initialValue,
      render,
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
    };
  }

  it("preserves typing focus across draft switches without taking focus from another control", async () => {
    const composer = await mountComposer("Draft B");
    const previousEditor = composer.editor();
    await act(async () => {
      previousEditor.commands.setTextSelection(previousEditor.state.doc.content.size - 1);
      previousEditor.view.focus();
    });
    expect(document.activeElement).toBe(previousEditor.view.dom);

    await composer.render("b");
    const nextEditor = composer.editor();
    expect(nextEditor).not.toBe(previousEditor);
    expect(document.activeElement).toBe(nextEditor.view.dom);
    await act(async () => userEvent.keyboard("x"));
    expect(composer.draft().value).toBe("xDraft B");

    const button = document.createElement("button");
    container.append(button);
    button.focus();
    await composer.render("a");
    expect(document.activeElement).toBe(button);
    expect(composer.draft().value).toBe(composer.initialValue);
  });

  it("restores a deleted chip and its file bytes on same-draft undo, then releases them on unmount", async () => {
    const composer = await mountComposer();
    await composer.deleteDraft();
    expect(composer.draft()).toEqual({ value: "", files: [] });
    const retained = composer.retained();
    expect(retained.files.get(fileContextReference(file).contextId)?.file).toBe(file.file);

    await composer.render("a");
    await composer.undo();
    expect(serializeEditorDoc(composer.editor().state.doc).value).toBe(composer.initialValue);
    expect(composer.draft()).toEqual({ value: composer.initialValue, files: [file] });
    expect(composer.draft().files[0]?.file).toBe(file.file);

    await composer.deleteDraft();
    await act(async () => root.unmount());
    expect(retained.files.size).toBe(0);
    root = createRoot(container);
  });

  it.each(["", "Draft B"])(
    "releases deleted payloads and prevents undo into the previous draft when switching to %j",
    async (destinationValue) => {
      const composer = await mountComposer(destinationValue);
      await composer.deleteDraft();
      expect(composer.draft()).toEqual({ value: "", files: [] });
      const retained = composer.retained();
      expect(retained.files.get(fileContextReference(file).contextId)?.file).toBe(file.file);

      await composer.render("b");
      expect(retained.files.size).toBe(0);
      await composer.undo();
      expect(serializeEditorDoc(composer.editor().state.doc).value).toBe(destinationValue);
      expect(composer.draft()).toEqual({ value: destinationValue, files: [] });

      await composer.render("a");
      await composer.undo();
      expect(serializeEditorDoc(composer.editor().state.doc).value).toBe("");
      expect(composer.draft()).toEqual({ value: "", files: [] });
    },
  );
});
