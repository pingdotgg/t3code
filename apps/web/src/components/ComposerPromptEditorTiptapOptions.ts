import { type TiptapEditorHTMLElement } from "@tiptap/core";


import { newlineInCode, splitBlockKeepMarks } from "@tiptap/pm/commands";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

import type { ServerProviderSkill } from "@t3tools/contracts";

import { pastedPathQueryLength } from "~/composer-logic";

import { caretLineDirection } from "~/composer-text-direction";
import {
  collectComposerPromptInlineTokens,
  selectionTouchesMentionBoundary,
} from "~/composer-editor-mentions";
import {
  buildDocJson,
  flatToMarkdown,
  pmToFlat,
  serializeEditorDoc,
  skillChipReplacements,
  splitOrLiftListItem,
  stepCaretAcrossStyledEdge,
} from "~/composer-rich-text-doc";
import {
  convertCodeFenceOnEnter,
  exitCodeBlockOnClosingFence,
  exitCodeBlockOnTrailingBlankLines,
  indentCodeBlock,
  indentedNewlineInCodeBlock,
  selectionInOneCodeBlock,
} from "~/composer-code-block";
import { markAsClipboardEdit } from "~/composer-undo-grouping";

import { isMacPlatform } from "~/lib/utils";

import { importPastedComposerText } from "./composerInlineTokenPaste";

import type { ComposerPromptEditorProps } from "./ComposerPromptEditorTiptapTypes";
import {
  composerSkillMeta,
  hasAncestor,
  isInCodeBlock,
  PLAIN_TEXT_EXTENSIONS,
  replaceSkillChips,
  RICH_TEXT_EXTENSIONS,
  type TiptapEditor,
} from "./ComposerPromptEditorTiptapExtensions";
import { SURROUND_CLOSE } from "./composerPromptEditorTiptapContexts";
import type { UseEditorOptions } from "@tiptap/react";
import type { SkillMeta } from "~/composer-rich-text-doc";
import {
  insertMarkdownParagraphs,
  scrollTiptapCaretIntoView,
} from "./ComposerPromptEditorTiptapHelpers";

interface ComposerTiptapReadCallbacks {
  readonly onCommandKeyDown: NonNullable<ComposerPromptEditorProps["onCommandKeyDown"]> | undefined;
  readonly isPathQueryActive:
    | NonNullable<ComposerPromptEditorProps["isPathQueryActive"]>
    | undefined;
  readonly importContextFragment:
    | NonNullable<ComposerPromptEditorProps["importContextFragment"]>
    | undefined;
}

export function createComposerTiptapEditorOptions(
  disabled: boolean,
  editorAttributes: Record<string, string>,
  literalText: boolean,
  onEditorChange: (updated: TiptapEditor) => void,
  readCallbacks: () => ComposerTiptapReadCallbacks,
  richText: boolean,
  skillLabelFor: (name: string) => SkillMeta | null,
  skills: ReadonlyArray<ServerProviderSkill>,
  value: string,
): UseEditorOptions {
  return {
    extensions: richText ? RICH_TEXT_EXTENSIONS : PLAIN_TEXT_EXTENSIONS,
    content: buildDocJson(value, (name) => composerSkillMeta(skills, name), {
      styling: richText,
      literalText,
    }),
    editable: !disabled,
    editorProps: {
      attributes: editorAttributes,
      handleKeyDown: (view, event) => {
        // In a right-to-left line the start is on the right.
        const backArrow = caretLineDirection(view.state) === "rtl" ? "ArrowRight" : "ArrowLeft";
        const boundary = event.metaKey
          ? event.key === "ArrowLeft" || event.key === "ArrowRight"
            ? "lineboundary"
            : event.key === "ArrowUp" || event.key === "ArrowDown"
              ? "documentboundary"
              : null
          : event.key === "Home" || event.key === "End"
            ? "lineboundary"
            : null;
        if (
          isMacPlatform(navigator.platform) &&
          boundary &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.isComposing
        ) {
          const selection = window.getSelection();
          if (
            selection?.anchorNode &&
            view.dom.contains(selection.anchorNode) &&
            typeof selection.modify === "function"
          ) {
            event.preventDefault();
            event.stopPropagation();
            const backward =
              event.key === "Home" || event.key === "ArrowUp" || event.key === backArrow;
            selection.modify(
              event.shiftKey ? "extend" : "move",
              backward ? "backward" : "forward",
              boundary,
            );
            if (selection.anchorNode && selection.focusNode) {
              const tr = view.state.tr.setSelection(
                TextSelection.create(
                  view.state.doc,
                  view.posAtDOM(selection.anchorNode, selection.anchorOffset),
                  view.posAtDOM(selection.focusNode, selection.focusOffset),
                ),
              );
              // A marker has two caret stops at one document position. Keep
              // the outer stop when native navigation reaches a boundary.
              if (richText && tr.selection.empty) {
                const { $head } = tr.selection;
                tr.setStoredMarks((backward ? $head.nodeBefore : $head.nodeAfter)?.marks ?? []);
              }
              view.dispatch(tr.scrollIntoView());
            }
            return true;
          }
        }
        if (
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
          !event.shiftKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing &&
          view.state.selection.empty
        ) {
          const { $from } = view.state.selection;
          const direction = event.key === "ArrowUp" || event.key === backArrow ? -1 : 1;
          const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
          // At document edges, Up/Down may cross markers without changing position; record the stop to
          // preserve the caret.
          const atDocumentEdge =
            $from.pos ===
            (direction === -1
              ? TextSelection.atStart(view.state.doc).from
              : TextSelection.atEnd(view.state.doc).to);
          // Visit the styled edge's other stop before a chip so the plain stop stays reachable.
          const step =
            horizontal || atDocumentEdge ? stepCaretAcrossStyledEdge(view.state, direction) : null;
          if (step) {
            event.preventDefault();
            event.stopPropagation();
            view.dispatch(step);
            return true;
          }
          const adjacent = direction === -1 ? $from.nodeBefore : $from.nodeAfter;
          if (horizontal && adjacent?.type.name.startsWith("composer-")) {
            event.preventDefault();
            event.stopPropagation();
            view.dispatch(
              view.state.tr
                .setSelection(
                  TextSelection.create(view.state.doc, $from.pos + direction * adjacent.nodeSize),
                )
                .scrollIntoView(),
            );
            return true;
          }
        }
        // Native tab order skips citation comment buttons inside the editor.
        if (
          event.key === "Tab" &&
          event.shiftKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          view.state.selection.empty
        ) {
          const { $from } = view.state.selection;
          const citation = $from.nodeBefore;
          if (citation?.type.name === "composer-citation") {
            const chip = view.nodeDOM($from.pos - citation.nodeSize);
            const commentButton =
              chip instanceof HTMLElement
                ? chip.querySelector<HTMLElement>("[data-citation-comment-trigger]")
                : null;
            if (commentButton) {
              event.preventDefault();
              event.stopPropagation();
              commentButton.focus();
              return true;
            }
          }
        }
        if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
          event.stopPropagation();
          return true;
        }
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          return true;
        }
        if (
          event.key === "Tab" &&
          !event.metaKey &&
          !event.ctrlKey &&
          selectionInOneCodeBlock(view.state)
        ) {
          event.preventDefault();
          event.stopPropagation();
          return indentCodeBlock(view.state, event.shiftKey ? "out" : "in", (tr) =>
            view.dispatch(tr),
          );
        }
        if (
          event.key === "Enter" &&
          richText &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing
        ) {
          if (selectionInOneCodeBlock(view.state)) {
            event.preventDefault();
            event.stopPropagation();
            const dispatch = (tr: typeof view.state.tr) => view.dispatch(tr.scrollIntoView());
            return (
              exitCodeBlockOnClosingFence(view.state, dispatch) ||
              exitCodeBlockOnTrailingBlankLines(view) ||
              indentedNewlineInCodeBlock(view.state, dispatch) ||
              newlineInCode(view.state, dispatch)
            );
          }
          if (convertCodeFenceOnEnter(view.state, (tr) => view.dispatch(tr))) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
        }
        const handler = readCallbacks().onCommandKeyDown;
        if (event.key === "Enter") {
          const instance = (view.dom as TiptapEditorHTMLElement).editor;
          const isTaskItem = richText && (instance?.isActive("taskItem") ?? false);
          const isListItem = richText && (instance?.isActive("listItem") ?? false);
          const handled = handler?.("Enter", event, isTaskItem || isListItem) ?? false;
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          event.preventDefault();
          if ((isTaskItem || isListItem) && instance && splitOrLiftListItem(instance)) {
            return true;
          }
          if (
            richText &&
            instance &&
            hasAncestor(view.state.selection.$from, "blockquote") &&
            view.state.selection.$from.parent.content.size === 0 &&
            instance.commands.lift("blockquote")
          ) {
            return true;
          }
          return splitBlockKeepMarks(view.state, (tr) => {
            view.dispatch(tr.scrollIntoView());
          });
        }
        if (!handler) return false;
        const handled = handler(event.key, event);
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
        return handled;
      },
      handleTextInput: (view, from, to, text) => {
        if (literalText || view.composing || text.length !== 1) return false;
        const closer = SURROUND_CLOSE[text];
        const { selection } = view.state;
        // Compose preedit updates replace a range even without a user selection.
        if (
          !closer ||
          !(selection instanceof TextSelection) ||
          selection.empty ||
          selection.from !== from ||
          selection.to !== to
        ) {
          return false;
        }
        // Do not wrap chips, atoms, or styled text; default replacement preserves marks.
        let touchesSpecial = false;
        view.state.doc.nodesBetween(from, to, (node) => {
          if (
            (node.isAtom && node.isInline && !node.isText) ||
            (node.isText && node.marks.length > 0)
          ) {
            touchesSpecial = true;
            return false;
          }
          return true;
        });
        if (touchesSpecial) return false;
        const map = serializeEditorDoc(view.state.doc);
        const startMd = flatToMarkdown(map, pmToFlat(map, from));
        const endMd = flatToMarkdown(map, pmToFlat(map, to));
        if (selectionTouchesMentionBoundary(map.value, startMd, endMd)) return false;
        const tr = view.state.tr.insertText(closer, to).insertText(text, from);
        tr.setSelection(TextSelection.create(tr.doc, from + text.length, to + text.length));
        view.dispatch(tr);
        return true;
      },
      handlePaste: (view, event) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData || clipboardData.files.length > 0) return false;
        const pastedText = clipboardData.getData("text/plain");
        if (!pastedText) return false;
        event.preventDefault();
        // Paste verbatim inside fences; markdown parsing would split blocks and create unsupported chips.
        if (isInCodeBlock(view)) {
          const { from, to } = view.state.selection;
          view.dispatch(
            markAsClipboardEdit(
              view.state.tr.insertText(pastedText, from, to),
              "paste",
            ).scrollIntoView(),
          );
          return true;
        }
        const importFragment = readCallbacks().importContextFragment;
        let text =
          !literalText && importFragment
            ? importPastedComposerText(clipboardData, importFragment)
            : pastedText;
        const tokens = literalText ? [] : collectComposerPromptInlineTokens(`${text}\n`);
        const isChip = (token: (typeof tokens)[number] | undefined) =>
          token?.type === "mention" ||
          (token?.type === "skill" && skillLabelFor(token.value) !== null);
        const lastToken = tokens.at(-1);
        if (isChip(lastToken) && lastToken?.end === text.length) {
          text += " ";
        }
        if (isChip(tokens[0]) && tokens[0]?.start === 0) {
          const map = serializeEditorDoc(view.state.doc);
          const offset = flatToMarkdown(map, pmToFlat(map, view.state.selection.from));
          if (offset > 0 && !/\s/.test(map.value[offset - 1]!)) text = ` ${text}`;
        }
        const { $from } = view.state.selection;
        const lineBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
        const literalLength = literalText
          ? 0
          : pastedPathQueryLength(lineBefore, text, readCallbacks().isPathQueryActive?.());
        const editorInstance = (view.dom as TiptapEditorHTMLElement).editor;
        if (editorInstance) {
          const $paste = view.state.selection.$from;
          const nested = ["listItem", "taskItem", "blockquote"].some((name) =>
            hasAncestor($paste, name),
          );
          insertMarkdownParagraphs(
            text,
            skillLabelFor,
            { styling: richText, blocks: !nested, literalText, literalLength },
            (content) => {
              editorInstance
                .chain()
                .command(({ tr }) => {
                  markAsClipboardEdit(tr, "paste");
                  return true;
                })
                .insertContent(content)
                .command(({ tr }) => {
                  // Move after a pasted rule so the next keystroke cannot replace it; add a trailing line
                  // if needed.
                  const { selection } = tr;
                  if (!(selection instanceof NodeSelection) || !selection.node.isBlock) {
                    return true;
                  }
                  if (!tr.doc.resolve(selection.to).nodeAfter?.isTextblock) {
                    tr.insert(selection.to, tr.doc.type.schema.nodes.paragraph!.create());
                  }
                  tr.setSelection(TextSelection.create(tr.doc, selection.to + 1));
                  return true;
                })
                .run();
            },
          );
          scrollTiptapCaretIntoView(editorInstance);
        }
        return true;
      },
    },
    onUpdate: ({ editor: updated, transaction }) => {
      // Undo can restore a chip for a skill the current provider no longer offers.
      if (!literalText && isHistoryTransaction(transaction)) {
        const stale = skillChipReplacements(updated.state.doc, skillLabelFor).filter(
          ({ node }) => node.isText,
        );
        if (stale.length > 0) {
          replaceSkillChips(updated, stale);
          return;
        }
      }
      onEditorChange(updated);
    },
    onSelectionUpdate: ({ editor: updated }) => {
      onEditorChange(updated);
    },
  };
}
