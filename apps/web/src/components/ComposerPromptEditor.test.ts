import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  PASTE_COMMAND,
} from "lexical";

import { registerComposerInlineTokenPaste } from "./composerInlineTokenPaste";

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string, files: readonly File[] = []) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files,
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

  it("inserts pasted non-image files as mentions and leaves images to the attachment handler", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const plainTextFallback = vi.fn(() => true);
    const resolvePastedFilePath = vi.fn((file: File) =>
      file.name === "app.ts" ? "src/app.ts" : null,
    );
    const image = { name: "shot.png", type: "image/png" } as File;
    const source = { name: "app.ts", type: "text/plain" } as File;

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("Ask"));
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 3,
      resolvePastedFilePath,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent("", [image, source]);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(resolvePastedFilePath).toHaveBeenCalledOnce();
    expect(resolvePastedFilePath).toHaveBeenCalledWith(source);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "Ask <mention:src/app.ts> ",
    );
  });

  it("appends pasted file mentions when the selection is not a range", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const source = { name: "app.ts", type: "text/plain" } as File;

    // No selectEnd(): the paste lands with no range selection, as it does
    // when a chip is node-selected.
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("Ask"));
        $getRoot().append(paragraph);
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 3,
      resolvePastedFilePath: () => "src/app.ts",
    });

    const event = new TestClipboardEvent("", [source]);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "Ask <mention:src/app.ts> ",
    );
  });

  it("leaves an unavailable pasted file for the parent error handler", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const plainTextFallback = vi.fn(() => false);
    const source = { name: "app.ts", type: "text/plain" } as File;

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("Ask"));
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      getExpandedAbsoluteOffsetForPoint: () => 3,
      resolvePastedFilePath: () => null,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent("", [source]);
    let handled = true;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(false);
    expect(plainTextFallback).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe("Ask");
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
});
