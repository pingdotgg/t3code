export type XcodeMarkKind = "mark" | "todo" | "fixme";

export interface XcodeMark {
  readonly line: number;
  readonly kind: XcodeMarkKind;
  readonly title: string;
  readonly separator: boolean;
}

const COMMENT_MARK = /^\s*(?:\/\/+|\/\*+)\s*(MARK|TODO|FIXME)\s*:\s*(.*?)\s*(?:\*\/\s*)?$/i;
const PRAGMA_MARK = /^\s*#\s*pragma\s+mark\s*(.*)$/i;

function parseMarkBody(kind: XcodeMarkKind, body: string): Omit<XcodeMark, "line"> {
  const trimmed = body.trim();
  if (trimmed === "-") {
    return { kind, title: "", separator: true };
  }
  if (trimmed.startsWith("-")) {
    return { kind, title: trimmed.slice(1).trim(), separator: true };
  }
  return { kind, title: trimmed, separator: false };
}

function kindFromLabel(label: string): XcodeMarkKind {
  switch (label.toUpperCase()) {
    case "TODO":
      return "todo";
    case "FIXME":
      return "fixme";
    default:
      return "mark";
  }
}

/** Collect Xcode jump-bar landmarks from MARK comments and `#pragma mark`. */
export function parseXcodeMarks(source: string): XcodeMark[] {
  // Classic Mac CR-only files have no LF; normalize so marks are not collapsed into one line.
  const normalized = source.includes("\r") ? source.replace(/\r\n?/g, "\n") : source;
  const marks: XcodeMark[] = [];
  let line = 1;
  let start = 0;
  while (start <= normalized.length) {
    const end = normalized.indexOf("\n", start);
    const text = normalized.slice(start, end === -1 ? normalized.length : end);

    const comment = COMMENT_MARK.exec(text);
    if (comment) {
      marks.push({ line, ...parseMarkBody(kindFromLabel(comment[1]!), comment[2] ?? "") });
    } else {
      const pragma = PRAGMA_MARK.exec(text);
      if (pragma) {
        marks.push({ line, ...parseMarkBody("mark", pragma[1] ?? "") });
      }
    }

    if (end === -1) break;
    start = end + 1;
    line += 1;
  }
  return marks;
}

/** Label shown in a marks jump menu, matching Xcode’s jump bar copy. */
export function xcodeMarkMenuLabel(mark: XcodeMark): string | null {
  if (mark.kind === "todo") {
    return mark.title ? `TODO: ${mark.title}` : "TODO";
  }
  if (mark.kind === "fixme") {
    return mark.title ? `FIXME: ${mark.title}` : "FIXME";
  }
  return mark.title || null;
}
