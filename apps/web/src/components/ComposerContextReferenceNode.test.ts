import { describe, expect, it, vi } from "vite-plus/test";
import { $createParagraphNode, $getRoot, $isElementNode, createEditor } from "lexical";

import {
  $createComposerContextReferenceNode,
  ComposerContextReferenceNode,
} from "./ComposerContextReferenceNode";
import { splitPromptIntoComposerSegments } from "../composer-editor-mentions";

vi.mock("./composerContextPresentation", () => ({
  ComposerContextReferenceChip: () => null,
}));

const reference = { kind: "terminal", contextId: "ctx-1", label: "Terminal 1 lines 3-4" };
const link = "[Terminal 1 lines 3-4](t3-context://v1/terminal/ctx-1)";

function createReferenceEditor() {
  const editor = createEditor({ nodes: [ComposerContextReferenceNode] });
  editor.update(
    () => {
      $getRoot().append($createParagraphNode());
    },
    { discrete: true },
  );
  return editor;
}

function $referenceNodes() {
  const paragraph = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(paragraph)) throw new Error("Expected a paragraph");
  return paragraph.getChildren().filter((node) => node instanceof ComposerContextReferenceNode);
}

describe("ComposerContextReferenceNode", () => {
  it("renders its canonical link as text so the prompt carries identity", () => {
    const editor = createReferenceEditor();
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild();
        if (!$isElementNode(paragraph)) throw new Error("Expected a paragraph");
        paragraph.append($createComposerContextReferenceNode(reference, "ref-1"));
      },
      { discrete: true },
    );
    const text = editor.getEditorState().read(() => $getRoot().getTextContent());
    expect(text).toBe(link);
    expect(splitPromptIntoComposerSegments(text)).toEqual([
      { type: "context-reference", ...reference, source: link },
    ]);
  });

  it("round-trips through JSON keeping the occurrence id", () => {
    const editor = createReferenceEditor();
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild();
        if (!$isElementNode(paragraph)) throw new Error("Expected a paragraph");
        paragraph.append($createComposerContextReferenceNode(reference, "ref-1"));
      },
      { discrete: true },
    );
    const serialized = editor.getEditorState().toJSON();
    const restored = createReferenceEditor();
    restored.setEditorState(restored.parseEditorState(serialized));
    const nodes = restored.getEditorState().read(() =>
      $referenceNodes().map((node) => ({
        referenceId: node.__referenceId,
        reference: node.getReference(),
      })),
    );
    expect(nodes).toEqual([{ referenceId: "ref-1", reference }]);
  });

  it("mints a distinct occurrence id per created node while sharing the payload id", () => {
    const editor = createReferenceEditor();
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild();
        if (!$isElementNode(paragraph)) throw new Error("Expected a paragraph");
        paragraph.append(
          $createComposerContextReferenceNode(reference),
          $createComposerContextReferenceNode(reference),
        );
      },
      { discrete: true },
    );
    const nodes = editor.getEditorState().read(() => $referenceNodes());
    expect(nodes[0]!.__contextId).toBe(nodes[1]!.__contextId);
    expect(nodes[0]!.__referenceId).not.toBe(nodes[1]!.__referenceId);
    expect(nodes[0]!.__referenceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
