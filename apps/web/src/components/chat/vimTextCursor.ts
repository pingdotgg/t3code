let segmenter: Intl.Segmenter | undefined;

export type VimMotion = "h" | "j" | "k" | "l" | "w" | "b" | "e" | "0" | "^" | "$" | "{" | "}";
type Span = { start: number; end: number; linewise?: boolean };

export function isVimMotion(key: string): key is VimMotion {
  return key.length === 1 && "hjklwbe0^${}".includes(key);
}

export function createVimTextCursor(initialText: string) {
  const graphemes = (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));
  let text = initialText;
  let characters = graphemes.segment(text);
  let position = 0;
  let anchor = 0;
  let linewise = false;
  let column: number | undefined;

  const previous = (at: number) => characters.containing(at - 1)?.index ?? 0;
  const next = (at: number) => {
    const part = characters.containing(at);
    return part ? part.index + part.segment.length : text.length;
  };
  const snap = (at: number) => characters.containing(at)?.index ?? previous(text.length);
  const lineStart = (at: number) => (at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1);
  const lineEnd = (at: number) => {
    const index = text.indexOf("\n", at);
    return index === -1 ? text.length : index;
  };
  const firstNonblank = (at: number) => {
    const start = lineStart(at);
    const offset = text.slice(start, lineEnd(at)).search(/\S/u);
    return offset < 0 ? start : start + offset;
  };
  const setPosition = (at: number) => {
    position = snap(at);
    column = undefined;
  };

  const wordKind = (at: number, big: boolean) => {
    const char = characters.containing(at)?.segment ?? "";
    if (char.includes("\n")) return "newline";
    if (/^\s+$/u.test(char)) return "space";
    if (big || /^\w/.test(char)) return "word";
    if (/^\p{Script=Han}/u.test(char)) return "han";
    if (/^\p{Script=Hiragana}/u.test(char)) return "hiragana";
    if (/^\p{Script=Katakana}/u.test(char)) return "katakana";
    if (/^\p{Script=Hangul}/u.test(char)) return "hangul";
    return /^[\p{L}\p{N}\p{M}]/u.test(char) ? "word" : "punctuation";
  };
  const wordAt = (at: number, big: boolean): Span => {
    const kind = wordKind(at, big);
    let start = at;
    let end = next(at);
    while (start > 0 && wordKind(previous(start), big) === kind) start = previous(start);
    while (end < text.length && wordKind(end, big) === kind) end = next(end);
    return { start, end };
  };
  const paragraphAt = (at: number, around: boolean): Span => {
    let start = lineStart(at);
    let end = lineEnd(at);
    const blank = text.slice(start, end).trim() === "";
    const blankAbove = () => text.slice(lineStart(start - 1), start - 1).trim() === "";
    const blankBelow = () => text.slice(end + 1, lineEnd(end + 1)).trim() === "";
    while (start > 0 && blankAbove() === blank) start = lineStart(start - 1);
    while (end < text.length && blankBelow() === blank) end = lineEnd(end + 1);
    if (around) {
      if (end < text.length) {
        while (end < text.length && blankBelow() !== blank) end = lineEnd(end + 1);
      } else if (!blank) {
        while (start > 0 && blankAbove()) start = lineStart(start - 1);
      }
    }
    return { start, end, linewise: true };
  };
  const object = (key: string, around: boolean): Span | null => {
    if (!text) return null;
    if (key === "p") return paragraphAt(position, around);
    if (key !== "w" && key !== "W") return null;
    const big = key === "W";
    const span = wordAt(position, big);
    if (around) {
      if (span.end < text.length && wordKind(position, big) === "space" && text[span.end] !== "\n")
        span.end = wordAt(span.end, big).end;
      else if (span.end < text.length && wordKind(span.end, big) === "space")
        span.end = wordAt(span.end, big).end;
      else if (span.start > 0 && wordKind(previous(span.start), big) === "space")
        span.start = wordAt(previous(span.start), big).start;
    }
    return span;
  };
  const skipWhitespace = (at: number) => {
    while (at < text.length && /\s/u.test(text[at]!)) at = next(at);
    return at;
  };
  const wordMotion = (key: "w" | "b" | "e") => {
    if (key === "b") {
      let at = previous(position);
      while (at > 0 && /\s/u.test(text[at]!)) at = previous(at);
      return wordAt(at, false).start;
    }
    const end = wordAt(position, false).end;
    if (key === "e" && previous(end) > position && /\S/u.test(text[position]!))
      return previous(end);
    const at = skipWhitespace(end);
    if (at >= text.length) return previous(text.length);
    return key === "w" ? at : previous(wordAt(at, false).end);
  };
  const vertical = (down: boolean) => {
    const from = lineStart(position);
    let start = from;
    let end = lineEnd(position);
    do {
      if (down ? end >= text.length : start === 0) return position;
      start = down ? end + 1 : lineStart(start - 1);
      end = lineEnd(start);
    } while (start === end);
    if (column === undefined) {
      column = 0;
      for (let at = from; at < position; at = next(at)) column++;
    }
    let at = start;
    for (let i = 0; i < column && next(at) < end; i++) at = next(at);
    return at;
  };
  const move = (key: VimMotion) => {
    const before = position;
    if (key !== "j" && key !== "k") column = undefined;
    switch (key) {
      case "h":
        position = Math.max(lineStart(position), previous(position));
        break;
      case "l":
        position = Math.max(position, Math.min(next(position), previous(lineEnd(position))));
        break;
      case "j":
      case "k":
        position = vertical(key === "j");
        break;
      case "w":
      case "b":
      case "e":
        position = wordMotion(key);
        break;
      case "0":
        position = lineStart(position);
        break;
      case "^":
        position = firstNonblank(position);
        break;
      case "$":
        position = Math.max(lineStart(position), previous(lineEnd(position)));
        break;
      case "{": {
        let at = paragraphAt(position, false).start;
        if (at === position && at > 0) {
          while (at > 0 && /\s/u.test(text[at - 1]!)) at--;
          at = paragraphAt(previous(at), false).start;
        }
        position = at;
        break;
      }
      case "}": {
        let at = paragraphAt(position, false).end;
        while (at < text.length && text[at] === "\n") at++;
        position = at < text.length ? firstNonblank(at) : previous(text.length);
        break;
      }
    }
    return position !== before;
  };

  const selection = (): Span => {
    const start = Math.min(position, anchor);
    const end = Math.max(position, anchor);
    return linewise
      ? { start: lineStart(start), end: lineEnd(end), linewise: true }
      : { start, end: next(end) };
  };
  const contents = (span: Span) => text.slice(span.start, span.end) + (span.linewise ? "\n" : "");
  return {
    get position() {
      return position;
    },
    get cellEnd() {
      return next(position);
    },
    get isLinewise() {
      return linewise;
    },
    setPosition,
    lastLine: () => setPosition(firstNonblank(previous(text.length))),
    move,
    find: (kind: "f" | "F" | "t" | "T", target: string) => {
      if (graphemes.segment(target).containing(0)?.segment !== target) return false;
      const forward = kind === "f" || kind === "t";
      const start = lineStart(position);
      const end = lineEnd(position);
      for (let at = position; forward ? next(at) < end : at > start;) {
        at = forward ? next(at) : previous(at);
        if (characters.containing(at)?.segment === target) {
          setPosition(kind === "t" ? previous(at) : kind === "T" ? next(at) : at);
          return true;
        }
      }
      return false;
    },
    startSelection: (byLine: boolean, keepAnchor: boolean) => {
      if (!keepAnchor) anchor = position;
      linewise = byLine;
    },
    selection,
    contents,
    select: (span: Span) => {
      anchor = span.start;
      linewise = span.linewise === true;
      setPosition(linewise ? lineStart(span.end) : previous(span.end));
    },
    object,
    yankMotion: (key: VimMotion | "y") => {
      if (!text.length) return "";
      if (key === "y")
        return contents({ start: lineStart(position), end: lineEnd(position), linewise: true });
      if (key === "w")
        return text.slice(
          position,
          Math.min(lineEnd(position), skipWhitespace(wordAt(position, false).end)),
        );
      if (key === "l") return text.slice(position, Math.min(next(position), lineEnd(position)));
      const before = position;
      const savedColumn = column;
      move(key);
      const start = Math.min(before, position);
      const end = Math.max(before, position);
      const throughEnd = key === "$" || key === "e";
      const span =
        key === "j" || key === "k"
          ? { start: lineStart(start), end: lineEnd(end), linewise: true }
          : { start, end: throughEnd ? next(end) : end };
      position = before;
      column = savedColumn;
      return contents(span);
    },
    refresh: (updated: string) => {
      text = updated;
      characters = graphemes.segment(text);
      position = snap(position);
      anchor = snap(anchor);
    },
  };
}
