interface Point {
  readonly node: Node;
  readonly offset: number;
}

interface Ends {
  readonly anchor: number;
  readonly focus: number;
}

/** The rows the virtualizer has mounted, as offsets into the file's text. */
interface Mounted {
  readonly rows: NodeListOf<HTMLElement>;
  readonly firstLine: number;
  readonly start: number;
  readonly end: number;
}

/** Lines break where the renderer breaks them: at `\n`, `\r\n`, and a lone `\r`. */
function lineStarts(text: string) {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  return starts;
}

function sameRange(a: StaticRange | undefined, b: StaticRange | undefined) {
  if (!a || !b) return a === b;
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

function rowOf(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-line]") ?? null;
}

/**
 * A text selection in a virtualized file, kept as offsets into the file's text.
 * The browser's own selection can only reach mounted rows: an end whose row unmounts
 * collapses onto whatever is still there, so the offsets outlive it and are drawn back
 * onto the rows after every render.
 */
export class SourceSelection {
  #text = "";
  #lineStarts: number[] | undefined;
  #ends: Ends | undefined;
  #pressed = false;
  /** A press that places a caret, where a collapsed selection is the click's and never a kept one. */
  #clicking = false;
  /** The browser's selection as a render left it during a press, when nothing was drawn over it. */
  #parked: { readonly range: StaticRange | undefined } | undefined;

  #use(text: string) {
    if (text === this.#text) return;
    this.#text = text;
    this.#lineStarts = undefined;
    this.#ends = undefined;
    this.#parked = undefined;
  }

  get #starts() {
    return (this.#lineStarts ??= lineStarts(this.#text));
  }

  #lineEnd(line: number) {
    const next = this.#starts[line + 1];
    if (next === undefined) return this.#text.length;
    return this.#text.startsWith("\r\n", next - 2) ? next - 2 : next - 1;
  }

  #lineAt(offset: number) {
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.#starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  #mounted(root: ShadowRoot): Mounted | undefined {
    const rows = root.querySelectorAll<HTMLElement>("[data-line]");
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return undefined;
    const firstLine = Number(first.dataset.line) - 1;
    const start = this.#starts[firstLine];
    if (start === undefined) return undefined;
    return { rows, firstLine, start, end: this.#lineEnd(Number(last.dataset.line) - 1) };
  }

  /** `inRow` is false for a point between rows, which is where an unmounted row leaves one. */
  #offsetOf(point: Point, side: "start" | "end", mounted: Mounted) {
    const row = rowOf(point.node);
    const range = document.createRange();
    if (row) {
      const line = Number(row.dataset.line) - 1;
      range.setStart(row, 0);
      range.setEnd(point.node, point.offset);
      const start = this.#starts[line] ?? this.#text.length;
      return {
        inRow: true,
        offset: Math.min(start + range.toString().length, this.#lineEnd(line)),
      };
    }
    range.setStart(point.node, point.offset);
    const rows = [...mounted.rows];
    const near =
      side === "start"
        ? rows.find((candidate) => range.comparePoint(candidate, 0) >= 0)
        : rows.findLast(
            (candidate) => range.comparePoint(candidate, candidate.childNodes.length) <= 0,
          );
    const offset = near
      ? side === "start"
        ? this.#starts[Number(near.dataset.line) - 1]!
        : this.#lineEnd(Number(near.dataset.line) - 1)
      : side === "start"
        ? mounted.end
        : mounted.start;
    return { inRow: false, offset };
  }

  #pointAt(offset: number, mounted: Mounted): Point {
    const clamped = Math.max(mounted.start, Math.min(offset, mounted.end));
    const line = this.#lineAt(clamped);
    const row = mounted.rows[line - mounted.firstLine];
    if (!row) return { node: mounted.rows[0]!, offset: 0 };
    let column = clamped - this.#starts[line]!;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.nodeValue?.length ?? 0;
      if (column <= length) return { node, offset: column };
      column -= length;
    }
    return { node: row, offset: row.childNodes.length };
  }

  /**
   * Reads the browser's selection into the offsets. An end resting on the edge of the
   * mounted rows keeps its offset when that offset lies past the edge, and a render
   * (`afterRender`) keeps every end its unmounted row left between rows.
   */
  #read(root: ShadowRoot, afterRender: boolean) {
    const selection = document.getSelection();
    let range: StaticRange | undefined;
    try {
      range = selection?.getComposedRanges({ shadowRoots: [root] })[0];
    } catch {
      // Engines without composed ranges keep their own selection and copy.
      this.#ends = undefined;
      return undefined;
    }
    if (range && !(root.contains(range.startContainer) && root.contains(range.endContainer))) {
      this.#ends = undefined;
      return undefined;
    }
    const mounted = this.#mounted(root);
    if (!mounted) return undefined;
    if (!afterRender && this.#parked && sameRange(range, this.#parked.range)) return mounted;
    if (!selection || !range) {
      if (!afterRender) this.#ends = undefined;
      return mounted;
    }
    const start = this.#offsetOf(
      { node: range.startContainer, offset: range.startOffset },
      "start",
      mounted,
    );
    const end = this.#offsetOf(
      { node: range.endContainer, offset: range.endOffset },
      "end",
      mounted,
    );
    const backward = selection.direction === "backward";
    const previous = this.#ends;
    // Select All spans the shadow tree, so it holds every mounted row from outside them.
    const holdsEveryRow =
      !start.inRow && !end.inRow && start.offset === mounted.start && end.offset === mounted.end;
    if (!afterRender && holdsEveryRow) {
      this.#ends = { anchor: 0, focus: this.#text.length };
      return mounted;
    }
    const keeps = (now: typeof start, was: number | undefined) =>
      was !== undefined &&
      (now.inRow
        ? (now.offset === mounted.start && was < mounted.start) ||
          (now.offset === mounted.end && was > mounted.end)
        : afterRender);
    const anchor = backward ? end : start;
    const focus = backward ? start : end;
    const keepsAnchor = keeps(anchor, previous?.anchor);
    const keepsFocus = keeps(focus, previous?.focus);
    // A click collapses the selection, and it is a new one unless both ends were already there.
    const collapsed = start.offset === end.offset && start.inRow && end.inRow;
    if (collapsed && (this.#clicking || !(keepsAnchor && keepsFocus))) {
      this.#ends = { anchor: start.offset, focus: start.offset };
      return mounted;
    }
    this.#ends = {
      anchor: keepsAnchor ? previous!.anchor : anchor.offset,
      focus: keepsFocus ? previous!.focus : focus.offset,
    };
    return mounted;
  }

  /** Call when the browser's selection changes. */
  sync(root: ShadowRoot, text: string) {
    this.#use(text);
    this.#read(root, false);
  }

  #draw(root: ShadowRoot, mounted: Mounted | undefined) {
    this.#parked = undefined;
    if (!mounted || !this.#ends) return;
    const anchor = this.#pointAt(this.#ends.anchor, mounted);
    const focus = this.#pointAt(this.#ends.focus, mounted);
    const selection = document.getSelection();
    const range = selection?.getComposedRanges({ shadowRoots: [root] })[0];
    if (this.#pressed && anchor.node === focus.node && anchor.offset === focus.offset) {
      // Chromium stops extending a drag once a script collapses its selection, so a drag whose
      // ends are both unmounted keeps what the browser has left of it.
      this.#parked = { range };
      return;
    }
    const [start, end] = selection?.direction === "backward" ? [focus, anchor] : [anchor, focus];
    if (
      range?.startContainer === start.node &&
      range.startOffset === start.offset &&
      range.endContainer === end.node &&
      range.endOffset === end.offset
    ) {
      return;
    }
    selection?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }

  /** Call after rows mount or unmount, to draw the selection onto the rows now there. */
  render(root: ShadowRoot, text: string) {
    this.#use(text);
    if (this.#ends) this.#draw(root, this.#read(root, true));
  }

  press(extending: boolean) {
    this.#pressed = true;
    this.#clicking = !extending;
  }

  release(root: ShadowRoot, text: string) {
    if (!this.#pressed) return;
    this.#use(text);
    const mounted = this.#read(root, false);
    this.#pressed = false;
    this.#clicking = false;
    this.#draw(root, mounted);
  }

  /** The text to copy when the browser's own copy would miss part of it, else `undefined`. */
  copy(root: ShadowRoot, text: string) {
    this.#use(text);
    const mounted = this.#read(root, false);
    if (!mounted || !this.#ends) return undefined;
    const start = Math.min(this.#ends.anchor, this.#ends.focus);
    const end = Math.max(this.#ends.anchor, this.#ends.focus);
    if (start === end) return undefined;
    const whole = start === 0 && end === text.length;
    if (!whole && start >= mounted.start && end <= mounted.end) return undefined;
    return text.slice(start, end);
  }
}
