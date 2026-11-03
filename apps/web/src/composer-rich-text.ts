export type RichTextMark = "bold" | "italic" | "strike" | "code";

interface RichTextSpan {
  text: string;
  marks: RichTextMark[];
  sourceOffsets?: number[];
}

export const RICH_TEXT_DELIMITERS: Record<RichTextMark, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

function pushSpan(
  spans: RichTextSpan[],
  text: string,
  marks: RichTextMark[],
  sourceOffsets?: number[],
): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (
    last &&
    last.marks.length === marks.length &&
    last.marks.every((mark, index) => mark === marks[index])
  ) {
    last.text += text;
    if (sourceOffsets) for (const offset of sourceOffsets) last.sourceOffsets!.push(offset);
  } else {
    spans.push({ text, marks, ...(sourceOffsets ? { sourceOffsets } : {}) });
  }
}

export function parseInlineMarkdown(
  text: string,
  options?: { underscoreItalic?: boolean; sourceOffsets?: boolean },
): RichTextSpan[] {
  const root: RichTextSpan[] = [];
  const stack: { delimiter: string; from: number; mark: RichTextMark; spans: RichTextSpan[] }[] =
    [];
  const current = () => stack.at(-1)?.spans ?? root;
  const offsets = (from: number, to: number) =>
    options?.sourceOffsets
      ? Array.from({ length: to - from }, (_, index) => from + index)
      : undefined;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      pushSpan(
        current(),
        text.slice(index, index + 2),
        [],
        offsets(index, Math.min(index + 2, text.length)),
      );
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = text.slice(index).match(/^`+/)![0];
      let close = text.indexOf(run, index + run.length);
      while (close !== -1 && (text[close - 1] === "`" || text[close + run.length] === "`")) {
        close = text.indexOf(run, close + run.length);
      }
      if (close > index + run.length && !text.slice(index, close).includes("\n")) {
        let from = index + run.length;
        let to = close;
        if (
          run.length > 1 &&
          text[from] === " " &&
          text[to - 1] === " " &&
          /\S/.test(text.slice(from, to))
        ) {
          from += 1;
          to -= 1;
        }
        pushSpan(current(), text.slice(from, to), ["code"], offsets(from, to));
        index = close + run.length;
      } else {
        pushSpan(current(), run, [], offsets(index, index + run.length));
        index += run.length;
      }
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      pushSpan(current(), char, [], offsets(index, index + 1));
      index += 1;
      continue;
    }
    let end = index;
    while (text[end] === char) end += 1;
    const before = text[index - 1] ?? "";
    const after = text[end] ?? "";
    const canClose = before !== "" && !/\s/.test(before) && (char !== "_" || !/\w/.test(after));
    const canOpen = after !== "" && !/\s/.test(after) && (char !== "_" || !/\w/.test(before));
    while (index < end) {
      const top = stack.at(-1);
      const opensNestedBold =
        top?.mark === "italic" &&
        end - index === 2 &&
        canOpen &&
        (char === "*" || char === "_") &&
        !stack.some((frame) => frame.mark === "bold");
      if (
        !opensNestedBold &&
        canClose &&
        top &&
        text.startsWith(top.delimiter, index) &&
        index + top.delimiter.length <= end
      ) {
        stack.pop();
        for (const span of top.spans)
          pushSpan(current(), span.text, [top.mark, ...span.marks], span.sourceOffsets);
        index += top.delimiter.length;
      } else if (
        canOpen &&
        (char !== "~" || end - index >= 2) &&
        (char !== "_" || end - index >= 2 || options?.underscoreItalic !== false)
      ) {
        const length = char === "~" || end - index >= 2 ? 2 : 1;
        const mark = char === "~" ? "strike" : length === 2 ? "bold" : "italic";
        // Prevent self-nesting, including alternate delimiters, to bound the stack by supported styles.
        if (stack.some((frame) => frame.mark === mark)) {
          pushSpan(current(), text.slice(index, end), [], offsets(index, end));
          index = end;
          continue;
        }
        stack.push({
          delimiter: char.repeat(length),
          from: index,
          mark,
          spans: [],
        });
        index += length;
      } else {
        pushSpan(current(), text.slice(index, end), [], offsets(index, end));
        index = end;
      }
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    pushSpan(
      current(),
      frame.delimiter,
      [],
      offsets(frame.from, frame.from + frame.delimiter.length),
    );
    for (const span of frame.spans) pushSpan(current(), span.text, span.marks, span.sourceOffsets);
  }
  return root;
}

export function inlineCodeDelimiters(text: string) {
  let length = 1;
  for (const run of text.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const delimiter = "`".repeat(length);
  const padding = length > 1 && /^[ `]|[ `]$/.test(text) ? " " : "";
  return { open: delimiter + padding, close: padding + delimiter };
}
