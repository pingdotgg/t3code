import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  replaceTextRange,
} from "../../composer-logic";
import { buildDocJson, serializeEditorDoc } from "../../composer-rich-text-doc";
import {
  toKindScopedComposerContextId,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import { buildPendingUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
import { composerThreadReferenceText } from "./composerThreadReference";

const record = threadContextRecord(
  {
    environmentId: EnvironmentId.make("fixture-environment"),
    threadId: ThreadId.make("fixture-peer"),
  },
  "Parser [design]",
);
const contextReference = Node.create({
  name: "composer-context-reference",
  group: "inline",
  inline: true,
  atom: true,
  renderHTML: () => ["span"],
  addAttributes: () => ({
    kind: { default: "" },
    contextId: { default: "" },
    label: { default: "" },
    source: { default: "" },
  }),
});

describe("thread references in question answers", () => {
  it("preserves the selected identity through editing and the submitted answer", () => {
    const draft = "Speak with @Parser to figure this out.";
    const trigger = detectComposerTrigger(draft, "Speak with @Parser".length)!;
    const replacement = `${composerThreadReferenceText(record, true)} `;
    const next = replaceTextRange(draft, trigger.rangeStart, trigger.rangeEnd + 1, replacement);
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), contextReference],
      content: buildDocJson(next.text, (name) => ({ label: name, description: null }), {
        answerThreadLinks: true,
      }),
    });
    try {
      // The link occupies one editor character while retaining its full wire source.
      editor.commands.setTextSelection(
        collapseExpandedComposerCursor(next.text, next.cursor, false, true) + 1,
      );
      editor.commands.insertContent("now ");
      const edited = serializeEditorDoc(editor.state.doc).value;
      const answers = buildPendingUserInputAnswers(
        [
          {
            id: "q",
            options: [],
            multiSelect: false,
          },
        ],
        { q: { customAnswer: edited } },
      );
      expect(answers).toEqual({
        q: "Speak with [Parser design](t3-thread://v2/fixture-environment/fixture-peer) now to figure this out.",
      });
      expect(collectInlineContextIds(edited)).toEqual([]);

      // Revisit the saved answer: rebuild the atom, select it and delete it as a unit.
      editor.commands.setContent(
        buildDocJson(edited, (name) => ({ label: name, description: null }), {
          answerThreadLinks: true,
        }),
      );
      const chipPosition = "Speak with ".length + 1;
      const chip = editor.state.doc.nodeAt(chipPosition)!;
      expect(chip.type.name).toBe("composer-context-reference");
      expect(chip.attrs).toMatchObject({
        kind: "thread",
        contextId: toKindScopedComposerContextId(
          "thread",
          composerThreadReferenceText(record, true),
        ),
        label: "Parser design",
      });
      editor.commands.setNodeSelection(chipPosition);
      editor.commands.deleteSelection();
      expect(serializeEditorDoc(editor.state.doc).value).toBe(
        "Speak with  now to figure this out.",
      );
    } finally {
      editor.destroy();
    }
  });

  it("keeps normal message references bound to their context record", () => {
    expect(collectInlineContextIds(composerThreadReferenceText(record, false))).toEqual([
      record.contextId,
    ]);
    const link = composerThreadReferenceText(record, true);
    const editor = new Editor({
      extensions: [StarterKit.configure({ link: false }), contextReference],
      content: buildDocJson(link, (name) => ({ label: name, description: null })),
    });
    try {
      expect(editor.state.doc.textContent).toBe(link);
      expect(serializeEditorDoc(editor.state.doc).value).toBe(link);
    } finally {
      editor.destroy();
    }
  });
});
