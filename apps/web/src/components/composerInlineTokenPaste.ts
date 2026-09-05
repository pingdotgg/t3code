import type { AssistantCitation } from "@t3tools/contracts";
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
  getExpandedAbsoluteOffsetForPoint: (node: LexicalNode, pointOffset: number) => number;
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
      const text = event.clipboardData.getData("text/plain");
      if (text.length === 0) {
        return false;
      }
      // Token grammar requires trailing whitespace; a virtual newline lets a
      // mention at the very end of the pasted text still parse.
      const tokens = collectComposerPromptInlineTokens(`${text}\n`).filter(
        (token) =>
          (token.type === "mention" || token.type === "citation") && token.end <= text.length,
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
