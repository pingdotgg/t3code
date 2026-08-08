import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
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

interface ComposerInlineTokenPasteOptions {
  createMentionNode: (path: string) => LexicalNode;
  getExpandedAbsoluteOffsetForPoint: (node: LexicalNode, pointOffset: number) => number;
  /**
   * Resolve a pasted OS file to the path it should be mentioned by, or null
   * when no path is available (browser builds). Non-image pasted files then
   * become mention chips at the cursor; image files are left for the
   * attachment paste handler either way.
   */
  resolvePastedFilePath?: (file: File) => string | null;
}

function $insertPastedFileMentions(
  event: ClipboardEvent,
  clipboardData: DataTransfer,
  options: ComposerInlineTokenPasteOptions,
): boolean {
  const resolvePastedFilePath = options.resolvePastedFilePath;
  if (resolvePastedFilePath === undefined) {
    return false;
  }
  const paths: string[] = [];
  for (const file of Array.from(clipboardData.files)) {
    if (file.type.startsWith("image/")) {
      continue;
    }
    const path = resolvePastedFilePath(file);
    if (path !== null && path.length > 0) {
      paths.push(path);
    }
  }
  if (paths.length === 0) {
    return false;
  }
  const selection = $getSelection();
  // The selection is not always a range when the paste lands (a chip can be
  // node-selected). Bailing here would drop the files entirely: the default
  // paste cannot turn them into mentions and the composer's paste handler
  // prevents it anyway, so fall back to inserting at the end of the prompt.
  const rangeSelection = $isRangeSelection(selection) ? selection : $getRoot().selectEnd();
  const nodes: LexicalNode[] = [];
  const startPoint = rangeSelection.isBackward() ? rangeSelection.focus : rangeSelection.anchor;
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
  for (const path of paths) {
    nodes.push(options.createMentionNode(path));
    // Mention tokens need trailing whitespace to stay valid in the
    // serialized prompt.
    nodes.push($createTextNode(" "));
  }
  rangeSelection.insertNodes(nodes);
  // Stop the editor's text paste; the event still bubbles, so the composer's
  // paste handler attaches any image files from the same clipboard.
  event.preventDefault();
  return true;
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
        return $insertPastedFileMentions(event, event.clipboardData, options);
      }
      const text = event.clipboardData.getData("text/plain");
      if (text.length === 0) {
        return false;
      }
      // Token grammar requires trailing whitespace; a virtual newline lets a
      // mention at the very end of the pasted text still parse.
      const mentions = collectComposerInlineTokens(`${text}\n`).filter(
        (token) => token.type === "mention" && token.end <= text.length,
      );
      if (mentions.length === 0) {
        return false;
      }

      // Lexical command listeners already run inside an editor update. Starting
      // a nested update here queues the mention insertion until after this
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
      const firstMention = mentions[0];
      if (firstMention && firstMention.start === 0) {
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
      for (const mention of mentions) {
        if (mention.start < cursor) {
          continue;
        }
        if (mention.start > cursor) {
          appendText(text.slice(cursor, mention.start));
        }
        nodes.push(options.createMentionNode(mention.value));
        cursor = mention.end;
      }
      if (cursor < text.length) {
        appendText(text.slice(cursor));
      } else {
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
