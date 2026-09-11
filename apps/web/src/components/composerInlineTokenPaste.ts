import type { AssistantCitation, ComposerContextClipboardFragment } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import {
  $createLineBreakNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

import { collectComposerPromptInlineTokens } from "../composer-editor-mentions";

interface ComposerInlineTokenPasteOptions {
  createMentionNode: (path: string) => LexicalNode;
  createCitationNode: (citation: AssistantCitation, source: string) => LexicalNode;
  createContextReferenceNode: (reference: {
    kind: string;
    contextId: string;
    label: string;
  }) => LexicalNode;
  getExpandedAbsoluteOffsetForPoint: (node: LexicalNode, pointOffset: number) => number;
  /**
   * Imports the records behind a structured paste into the draft. Returns the ids that had
   * to change (a re-attached binary gets a fresh local id) so the pasted links follow.
   */
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>;
}

export function registerComposerInlineTokenPaste(
  editor: LexicalEditor,
  options: ComposerInlineTokenPasteOptions,
): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      if (!(event instanceof ClipboardEvent) || event.clipboardData === null) {
        return false;
      }
      if (event.clipboardData.files.length > 0) {
        return false;
      }
      const pastedText = event.clipboardData.getData("text/plain");
      if (pastedText.length === 0) {
        return false;
      }
      // Only records whose links are in the pasted text get imported; a fragment may carry
      // more (it was built for a larger copy) and must not start transfers for those.
      const decodedFragment = options.importContextFragment
        ? decodeComposerContextFragment(
            event.clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME),
          )
        : null;
      const pastedIds = new Set<string>(
        collectComposerContextReferences(pastedText).map((occurrence) => occurrence.contextId),
      );
      if (decodedFragment) {
        for (const record of decodedFragment.records) {
          if (
            record.kind === "preview-annotation" &&
            !("payload" in record) &&
            pastedIds.has(record.contextId) &&
            record.screenshotContextId
          ) {
            pastedIds.add(record.screenshotContextId);
          }
        }
      }
      const fragment =
        decodedFragment === null
          ? null
          : {
              ...decodedFragment,
              records: decodedFragment.records.filter((record) => pastedIds.has(record.contextId)),
            };
      const rewrittenIds =
        fragment && fragment.records.length > 0 ? options.importContextFragment!(fragment) : null;
      const text =
        rewrittenIds && rewrittenIds.size > 0
          ? replaceComposerContextReferences(pastedText, (occurrence) => {
              const nextId = rewrittenIds.get(occurrence.contextId);
              return nextId
                ? occurrence.source.replace(`/${occurrence.contextId})`, `/${nextId})`)
                : occurrence.source;
            })
          : pastedText;
      // Token grammar requires trailing whitespace; a virtual newline lets a
      // mention at the very end of the pasted text still parse.
      const tokens = collectComposerPromptInlineTokens(`${text}\n`).filter(
        (token) =>
          (token.type === "mention" ||
            token.type === "citation" ||
            token.type === "context-reference") &&
          token.end <= text.length,
      );
      if (tokens.length === 0) {
        return false;
      }

      // Lexical command listeners already run inside an editor update. Starting
      // a nested update here queues the token insertion until after this
      // listener returns, which lets the plain-text paste handler run as well.
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return false;
      }
      const nodes: LexicalNode[] = [];
      const appendText = (value: string) => {
        const lines = value.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (line.length > 0) {
            nodes.push($createTextNode(line));
          }
          if (index < lines.length - 1) {
            nodes.push($createLineBreakNode());
          }
        }
      };
      const firstToken = tokens[0];
      if (firstToken?.type === "mention" && firstToken.start === 0) {
        const startPoint = selection.isBackward() ? selection.focus : selection.anchor;
        const insertionOffset = options.getExpandedAbsoluteOffsetForPoint(
          startPoint.getNode(),
          startPoint.offset,
        );
        const precedingChar = $getRoot()
          .getTextContent()
          .slice(insertionOffset - 1, insertionOffset);
        if (precedingChar.length > 0 && !/\s/.test(precedingChar)) {
          nodes.push($createTextNode(" "));
        }
      }
      let cursor = 0;
      for (const token of tokens) {
        if (token.start < cursor) {
          continue;
        }
        if (token.start > cursor) {
          appendText(text.slice(cursor, token.start));
        }
        nodes.push(
          token.type === "citation"
            ? options.createCitationNode(token.citation, token.source)
            : token.type === "context-reference"
              ? options.createContextReferenceNode({
                  kind: token.kind,
                  contextId: token.contextId,
                  label: token.label,
                })
              : options.createMentionNode(token.value),
        );
        cursor = token.end;
      }
      if (cursor < text.length) {
        appendText(text.slice(cursor));
      } else if (tokens.at(-1)?.type === "mention") {
        // Keep the serialized prompt valid: mention tokens need trailing
        // whitespace, so a paste ending in a mention gets the same
        // trailing space the autocomplete inserts.
        nodes.push($createTextNode(" "));
      }
      selection.insertNodes(nodes);
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}
