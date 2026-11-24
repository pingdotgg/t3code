import { messageTextRange, readMessageText } from "~/lib/assistantTextSelection";
import { createVimTextCursor } from "./vimTextCursor";

export function openVimMessageText(
  source: HTMLElement,
  previousCursor?: ReturnType<typeof createVimTextCursor>,
) {
  let stream = readMessageText(source, "\n\n");
  previousCursor?.refresh(stream.text);
  const cursor = previousCursor ?? createVimTextCursor(stream.text);
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
    const bounds = (node: Node) => {
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const index = firstBelow(chunks.length, (i) => {
      const node = chunks[i]!.node;
      const row = node.parentElement?.closest("tr");
      return (row?.getBoundingClientRect() ?? bounds(node)).bottom;
    });
    let chunk = chunks[index];
    const row = chunk?.node.parentElement?.closest("tr");
    if (row) {
      let nearestTop = Infinity;
      chunk = undefined;
      for (let i = index; i < chunks.length; i++) {
        const candidate = chunks[i]!;
        if (!row.contains(candidate.node)) {
          chunk ??= candidate;
          break;
        }
        const rect = bounds(candidate.node);
        if (rect.bottom <= y || rect.top >= nearestTop) continue;
        chunk = candidate;
        if (rect.top <= y) break;
        nearestTop = rect.top;
      }
    }
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
    const pre = cell?.startContainer.parentElement?.closest("pre");
    if (pre && cell) {
      const rect = cell.getBoundingClientRect();
      const box = pre.getBoundingClientRect();
      if (rect.left < box.left) pre.scrollLeft += rect.left - box.left;
      else if (rect.right > box.right) pre.scrollLeft += rect.right - box.right;
    }
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
