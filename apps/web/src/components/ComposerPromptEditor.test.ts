import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  PASTE_COMMAND,
} from "lexical";

import { registerComposerInlineTokenPaste } from "./composerInlineTokenPaste";
import {
  $consumeComposerCitationCommentRequest,
  $createComposerCitationNode,
  ComposerCitationNode,
  type ComposerCitationCommentRequest,
} from "./ComposerCitationNode";
import { splitPromptIntoComposerSegments } from "../composer-editor-mentions";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

vi.mock("./chat/AssistantCitationChip", () => ({ AssistantCitationChip: () => null }));

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("remote/雪"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  text: 'Keep "👋", (punctuation) and @AGENTS.md.',
  start: 5,
  end: 43,
  prefix: "前: ",
  suffix: " 後",
};
const citationSource = serializeAssistantCitation(citation).replaceAll("+", "%20");

function createCitationEditor(text = "") {
  const editor = createEditor({ nodes: [ComposerCitationNode] });
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      $getRoot().append(paragraph);
      if (text) paragraph.append($createTextNode(text));
      paragraph.selectEnd();
    },
    { discrete: true },
  );
  registerComposerInlineTokenPaste(editor, {
    createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
    createCitationNode: $createComposerCitationNode,
    getExpandedAbsoluteOffsetForPoint: (_node, offset) => offset,
  });
  return editor;
}

function $citationNodes() {
  const paragraph = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
  return paragraph.getChildren().filter((node) => node instanceof ComposerCitationNode);
}

function pasteText(editor: ReturnType<typeof createEditor>, text: string) {
  const event = new TestClipboardEvent(text);
  editor.update(
    () => {
      editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
    },
    { discrete: true },
  );
  return event;
}

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

describe("registerComposerInlineTokenPaste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles a copied mention without also running the plain-text paste fallback", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[improve-deploy-error-logging.md](.changeset/improve-deploy-error-logging.md)";
    const plainTextFallback = vi.fn(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(mention);
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      createCitationNode: $createComposerCitationNode,
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:.changeset/improve-deploy-error-logging.md> ",
    );
  });

  it.each([
    "yarn expo install @expo/ui",
    "npm install @jane/foo.js",
    "import '@scope/pkg/sub/path'",
  ])("leaves scoped package command %s to the plain-text paste fallback", (command) => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const plainTextFallback = vi.fn((event: ClipboardEvent) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(event.clipboardData?.getData("text/plain") ?? "");
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      createCitationNode: $createComposerCitationNode,
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(command);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).toHaveBeenCalledOnce();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(command);
  });

  it("pastes a canonical scoped folder link as a mention", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[sub](@scope/pkg/sub)";
    const plainTextFallback = vi.fn(() => true);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      createCitationNode: $createComposerCitationNode,
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:@scope/pkg/sub> ",
    );
  });

  it("restores multiple citation nodes beside punctuation and Unicode without changing their source", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor();
    const secondSource = serializeAssistantCitation({
      ...citation,
      messageId: MessageId.make("message-2"),
      text: "Another quote 👋",
    });
    const text = `前(${citationSource}),${secondSource}${citationSource}`;
    const plainTextFallback = vi.fn(() => true);
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = pasteText(editor, text);

    expect(event.defaultPrevented).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe(text);
      expect($citationNodes().map((node) => node.getTextContent())).toEqual([
        citationSource,
        secondSource,
        citationSource,
      ]);
    });
  });

  it("restores citations alongside mentions and only pads a trailing mention", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor();

    pasteText(editor, `${citationSource}\n[AGENTS.md](AGENTS.md) ${citationSource}`);

    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe(
        `${citationSource}\n<mention:AGENTS.md> ${citationSource}`,
      );
      expect($citationNodes()).toHaveLength(2);
    });

    const trailingMentionEditor = createCitationEditor();
    pasteText(trailingMentionEditor, `${citationSource} [AGENTS.md](AGENTS.md)`);

    expect(trailingMentionEditor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      `${citationSource} <mention:AGENTS.md> `,
    );
  });

  it.each(["what do you mean??\nPlease keep the indentation:\n  café 👋"])(
    "keeps the edited comment %j bound to its quote through an editor reload and paste",
    (comment) => {
      vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
      const editor = createCitationEditor();
      const commentedCitation = { ...citation, comment };
      const source = serializeAssistantCitation(commentedCitation);
      pasteText(editor, `前(${citationSource})後`);
      editor.update(
        () => {
          $citationNodes()[0]!.setComment(comment);
        },
        { discrete: true },
      );

      editor.getEditorState().read(() => {
        expect($getRoot().getTextContent()).toBe(`前(${source})後`);
        expect($citationNodes()[0]!.exportJSON().citation).toEqual(commentedCitation);
      });

      const restored = createCitationEditor();
      restored.setEditorState(restored.parseEditorState(editor.getEditorState().toJSON()));
      restored.update(
        () => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
          paragraph.selectStart().insertText("About ");
        },
        { discrete: true },
      );

      restored.getEditorState().read(() => {
        expect($getRoot().getTextContent()).toBe(`About 前(${source})後`);
        expect($getRoot().getChildrenSize()).toBe(1);
        expect($citationNodes()[0]!.exportJSON().citation).toEqual(commentedCitation);
      });

      const pasted = createCitationEditor();
      pasteText(
        pasted,
        restored.getEditorState().read(() => $getRoot().getTextContent()),
      );
      pasted.getEditorState().read(() => {
        expect($getRoot().getTextContent()).toBe(`About 前(${source})後`);
        expect($citationNodes()[0]!.exportJSON().citation).toEqual(commentedCitation);
      });
    },
  );

  it("edits only one repeated quote without moving selection or mutating earlier editor states", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor();
    const prompt = `前(${citationSource}),(${citationSource})後`;
    pasteText(editor, prompt);
    editor.update(
      () => {
        $getRoot().getAllTextNodes().at(-1)!.select(2, 1);
      },
      { discrete: true },
    );
    const beforeEdit = editor.getEditorState();
    const selection = beforeEdit.read(() => $getSelection()!.clone());
    const node = beforeEdit.read(() => $citationNodes()[1]!);
    editor.update(() => node.setComment("First draft"), { discrete: true });
    const comment = "Use this occurrence, not the earlier quote.";
    editor.update(() => node.setComment(comment), { discrete: true });
    const afterEdit = editor.getEditorState();
    const source = serializeAssistantCitation({ ...citation, comment });

    afterEdit.read(() => {
      expect($getRoot().getTextContent()).toBe(`前(${citationSource}),(${source})後`);
      expect($citationNodes().map((citationNode) => citationNode.exportJSON().citation)).toEqual([
        citation,
        { ...citation, comment },
      ]);
      expect($getSelection()?.is(selection)).toBe(true);
    });
    beforeEdit.read(() => {
      expect($getRoot().getTextContent()).toBe(prompt);
      expect($citationNodes().map((citationNode) => citationNode.exportJSON().citation)).toEqual([
        citation,
        citation,
      ]);
    });

    editor.setEditorState(beforeEdit);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(prompt);
    editor.setEditorState(afterEdit);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      `前(${citationSource}),(${source})後`,
    );
  });

  it.each(["", " \n\t "])("clears a comment with %j without removing the quote", (comment) => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor();
    pasteText(editor, citationSource);
    editor.update(() => $citationNodes()[0]!.setComment("Remove this comment."), {
      discrete: true,
    });
    editor.update(() => $citationNodes()[0]!.setComment(comment), { discrete: true });

    editor.getEditorState().read(() => {
      expect($citationNodes()).toHaveLength(1);
      expect($citationNodes()[0]!.exportJSON().citation).toStrictEqual(citation);
      expect($getRoot().getTextContent()).toBe(serializeAssistantCitation(citation));
    });
  });

  it("keeps a citation pasted after an unfinished @ restorable as a chip", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor("@");

    pasteText(editor, citationSource);

    const prompt = editor.getEditorState().read(() => $getRoot().getTextContent());
    expect(splitPromptIntoComposerSegments(prompt)).toEqual([
      { type: "text", text: "@" },
      { type: "citation", citation, source: citationSource },
    ]);
  });

  it("copies, cuts, and pastes selected citation nodes with all source metadata intact", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor();
    const firstCitation = { ...citation, comment: "Explain the first occurrence." };
    const secondCitation = { ...citation, comment: "Keep the second occurrence.\n  café 👋" };
    const selectedText = `${serializeAssistantCitation(firstCitation)},${serializeAssistantCitation(secondCitation)}`;
    pasteText(editor, `before ${citationSource},${citationSource} after`);
    editor.update(
      () => {
        $citationNodes()[0]!.setComment(firstCitation.comment);
        $citationNodes()[1]!.setComment(secondCitation.comment);
      },
      { discrete: true },
    );
    let copied = "";
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
        paragraph.select(1, 4);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
        copied = selection.getTextContent();
        selection.removeText();
      },
      { discrete: true },
    );

    expect(copied).toBe(selectedText);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe("before  after");

    pasteText(editor, copied);

    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe(`before ${selectedText} after`);
      expect($citationNodes().map((node) => node.exportJSON().citation)).toEqual([
        firstCitation,
        secondCitation,
      ]);
    });
  });

  it.each([true, false])(
    "deletes a citation and its comment atomically, backwards=%s",
    (backwards) => {
      const editor = createCitationEditor();
      const commentedCitation = { ...citation, comment: "Delete this with its quote.\n  café 👋" };
      const source = serializeAssistantCitation(commentedCitation);
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
          const before = $createTextNode("前(");
          const after = $createTextNode(")後");
          paragraph.append(
            before,
            $createComposerCitationNode(citation, citationSource).setComment(
              commentedCitation.comment,
            ),
            after,
          );
          if (backwards) {
            after.selectStart();
          } else {
            before.selectEnd();
          }
        },
        { discrete: true },
      );
      const beforeDeletion = editor.getEditorState();
      const serialized = beforeDeletion.toJSON();

      editor.update(
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
          selection.deleteCharacter(backwards);
        },
        { discrete: true },
      );

      const afterDeletion = editor.getEditorState();
      expect(afterDeletion.read(() => $getRoot().getTextContent())).toBe("前()後");

      editor.setEditorState(beforeDeletion);
      expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
        `前(${source})後`,
      );
      editor.setEditorState(afterDeletion);
      expect(editor.getEditorState().read(() => $citationNodes())).toHaveLength(0);

      editor.setEditorState(editor.parseEditorState(serialized));
      editor.getEditorState().read(() => {
        expect($getRoot().getTextContent()).toBe(`前(${source})後`);
        expect($citationNodes()[0]?.exportJSON().citation).toEqual(commentedCitation);
      });
    },
  );
});

describe("citation comment opening", () => {
  const sourceAnchor: AssistantCitationSourceAnchor = {
    source: { nodeType: 1 } as HTMLElement,
    range: { collapsed: false } as Range,
    viewport: { nodeType: 1 } as HTMLElement,
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens only the newly inserted occurrence after committing its exact prompt", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor();
    const previousValue = `前 ${citationSource} middle\nbefore after ${citationSource} 後`;
    pasteText(editor, previousValue);
    const citationStart = `前 ${citationSource} middle\nbefore `.length;
    const value =
      previousValue.slice(0, citationStart) +
      `${citationSource} ` +
      previousValue.slice(citationStart);
    const request: ComposerCitationCommentRequest = {
      previousValue,
      value,
      citationStart,
      sourceAnchor,
    };
    const requestRef = { current: request as ComposerCitationCommentRequest | null };

    editor.getEditorState().read(() => {
      expect($consumeComposerCitationCommentRequest(requestRef)).toBeNull();
      expect(requestRef.current).toBe(request);
    });
    editor.update(
      () => {
        const text = $getRoot()
          .getAllTextNodes()
          .find((node) => node.getTextContent() === "before after ");
        if (!text) throw new Error("Expected insertion text");
        text.select("before ".length, "before ".length);
      },
      { discrete: true },
    );
    pasteText(editor, `${citationSource} `);

    editor.getEditorState().read(() => {
      const selection = $getSelection()?.clone();
      expect($getRoot().getTextContent()).toBe(value);
      expect($citationNodes()).toHaveLength(3);
      const target = $consumeComposerCitationCommentRequest(requestRef);
      expect(target?.nodeKey).toBe($citationNodes()[1]!.getKey());
      expect(target?.sourceAnchor).toBe(sourceAnchor);
      expect($getSelection()?.is(selection!)).toBe(true);
      expect($consumeComposerCitationCommentRequest(requestRef)).toBeNull();
    });
  });

  it("does not reopen comments when an inserted citation is restored or pasted", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor("before ");
    const previousState = editor.getEditorState();
    const value = `before ${citationSource} `;
    const requestRef: { current: ComposerCitationCommentRequest | null } = {
      current: { previousValue: "before ", value, citationStart: "before ".length, sourceAnchor },
    };
    pasteText(editor, `${citationSource} `);
    const insertedState = editor.getEditorState();
    insertedState.read(() => {
      expect($consumeComposerCitationCommentRequest(requestRef)?.nodeKey).toBe(
        $citationNodes()[0]!.getKey(),
      );
    });
    editor.update(() => $citationNodes()[0]!.setComment("Keep this attached."), {
      discrete: true,
    });
    const commentedState = editor.getEditorState();

    for (const restoredState of [previousState, insertedState, commentedState]) {
      editor.setEditorState(restoredState);
      editor.getEditorState().read(() => {
        expect($consumeComposerCitationCommentRequest(requestRef)).toBeNull();
      });
    }

    const reloaded = createCitationEditor();
    reloaded.setEditorState(reloaded.parseEditorState(commentedState.toJSON()));
    reloaded.getEditorState().read(() => {
      expect($consumeComposerCitationCommentRequest({ current: null })).toBeNull();
      expect($citationNodes()[0]!.exportJSON().citation.comment).toBe("Keep this attached.");
    });
    const pasted = createCitationEditor();
    pasteText(
      pasted,
      commentedState.read(() => $getRoot().getTextContent()),
    );
    pasted.getEditorState().read(() => {
      expect($consumeComposerCitationCommentRequest({ current: null })).toBeNull();
      expect($citationNodes()[0]!.exportJSON().citation.comment).toBe("Keep this attached.");
    });
  });

  it("discards an opening request if another prompt replaces the insertion", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createCitationEditor();
    const requestRef: { current: ComposerCitationCommentRequest | null } = {
      current: { previousValue: "", value: citationSource, citationStart: 0, sourceAnchor },
    };
    editor.update(
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error("Expected an insertion point");
        selection.insertText("A different draft");
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      expect($consumeComposerCitationCommentRequest(requestRef)).toBeNull();
    });
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if (!$isElementNode(paragraph)) throw new Error("Expected a composer paragraph");
        paragraph.clear().selectStart();
      },
      { discrete: true },
    );
    pasteText(editor, citationSource);
    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe(citationSource);
      expect($consumeComposerCitationCommentRequest(requestRef)).toBeNull();
    });
  });
});
