import { messageTextRange, readMessageText } from "~/lib/assistantTextSelection";
import { createVimTextCursor } from "./vimTextCursor";

export function openVimMessageText(source: HTMLElement) {
  let stream = readMessageText(source, "\n\n");
  const cursor = createVimTextCursor(stream.text);
  const needsTabIndex = !source.hasAttribute("tabindex");
  if (needsTabIndex) source.tabIndex = -1;
  let pageChunks: typeof stream.chunks | undefined;
  let stale = false;
  let cell: Range | null = null;
  let painted: Range | null = null;
  let block: Highlight | null = null;

  const clear = () => {
    if (block && CSS.highlights.get("t3-vim-cursor") === block)
      CSS.highlights.delete("t3-vim-cursor");
    block = null;
    const current = source.ownerDocument.getSelection();
    if (painted && current?.rangeCount && current.getRangeAt(0) === painted)
      current.removeAllRanges();
    painted = null;
  };
  const sync = () => {
    if (!stale) return;
    stream = readMessageText(source, "\n\n");
    pageChunks = undefined;
    cursor.refresh(stream.text);
    stale = false;
  };
  const caret = () => {
    sync();
    return messageTextRange(source, stream, cursor.position, cursor.cellEnd);
  };
  function moveToScreenY(y: number) {
    sync();
    const range = source.ownerDocument.createRange();
    const chunks = (pageChunks ??= stream.chunks.filter(({ start, end }) =>
      /\S/.test(stream.text.slice(start, end)),
    ));
    const firstBelow = (length: number, bottomAt: (index: number) => number) => {
      let low = 0;
      let high = length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (bottomAt(mid) <= y) low = mid + 1;
        else high = mid;
      }
      return low;
    };
    const index = firstBelow(chunks.length, (index) => {
      range.selectNodeContents(chunks[index]!.node);
      return range.getBoundingClientRect().bottom;
    });
    const chunk = chunks[index];
    if (!chunk) {
      cursor.setPosition(stream.text.length);
      return;
    }
    const node = chunk.node;
    const offset =
      node instanceof Text
        ? firstBelow(node.length, (i) => {
            range.setStart(node, 0);
            range.setEnd(node, i + 1);
            return range.getBoundingClientRect().bottom;
          })
        : 0;
    cursor.setPosition(Math.min(chunk.start + offset, chunk.end - 1));
  }
  function paint(visual: boolean) {
    clear();
    cell = caret();
    if (cell && typeof Highlight !== "undefined" && CSS.highlights) {
      block = new Highlight(cell);
      block.priority = 1;
      CSS.highlights.set("t3-vim-cursor", block);
      if (!visual) return cell;
    }
    const { start, end } = cursor.selection();
    const range = visual ? messageTextRange(source, stream, start, end) : cell;
    if (range) {
      const selection = source.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      painted = range;
    }
    return cell;
  }
  return {
    get cursor() {
      sync();
      return cursor;
    },
    caret(visual: boolean) {
      if (cell && (cell.collapsed || !source.contains(cell.commonAncestorContainer)))
        return paint(visual);
      return cell;
    },
    moveToScreenY,
    paint,
    close() {
      clear();
      if (needsTabIndex) source.removeAttribute("tabindex");
    },
    onMutation: (records: MutationRecord[], visual: boolean) => {
      stale = true;
      const range = painted ?? cell;
      if (
        !range ||
        range.collapsed ||
        records.some((record) => {
          const node = record.addedNodes[0] ?? record.nextSibling ?? record.target;
          return !source.contains(node) || range.comparePoint(node, 0) !== 1;
        })
      )
        paint(visual);
    },
  };
}
