import type { HighlightedToken } from "../../lib/highlights";
import { buildNativeSourceRows } from "./nativeSourceFileAdapter";

const MAX_CACHED_DOCUMENTS = 8;
const MAX_CACHED_CHARACTERS = 4 * 1024 * 1024;

export interface SourceFileDocument {
  readonly contents: string;
  readonly lines: ReadonlyArray<string>;
  readonly rowsJson: string;
}

const documentCache = new Map<string, SourceFileDocument>();
let cachedCharacterCount = 0;

function removeOldestCachedDocument(): void {
  const oldestKey = documentCache.keys().next().value;
  if (typeof oldestKey !== "string") {
    return;
  }
  const document = documentCache.get(oldestKey);
  documentCache.delete(oldestKey);
  cachedCharacterCount -= (document?.contents.length ?? 0) + (document?.rowsJson.length ?? 0);
}

export function prepareSourceFileDocument(contents: string): SourceFileDocument {
  const cached = documentCache.get(contents);
  if (cached !== undefined) {
    documentCache.delete(contents);
    documentCache.set(contents, cached);
    return cached;
  }

  const normalizedContents = contents.replace(/\r\n?/g, "\n");
  const lines = normalizedContents.split("\n");
  const document = {
    contents: normalizedContents,
    lines,
    rowsJson: JSON.stringify(buildNativeSourceRows(lines)),
  } satisfies SourceFileDocument;
  const characterCount = document.contents.length + document.rowsJson.length;

  if (characterCount <= MAX_CACHED_CHARACTERS) {
    while (
      documentCache.size >= MAX_CACHED_DOCUMENTS ||
      cachedCharacterCount + characterCount > MAX_CACHED_CHARACTERS
    ) {
      removeOldestCachedDocument();
    }
    documentCache.set(contents, document);
    cachedCharacterCount += characterCount;
  }

  return document;
}

// Virtualization prevents document-wide selection; cap spans and fall back to a fully selectable string.
export function boundedSelectableSourceTokens(
  tokens: ReadonlyArray<ReadonlyArray<HighlightedToken>> | null,
): typeof tokens {
  if (!tokens) return null;
  let spans = tokens.length;
  for (const line of tokens) {
    spans += line.length;
    if (spans > 2_000) return null;
  }
  return tokens;
}

export interface SelectableSourceHtmlStyle {
  readonly foreground: string;
  readonly selection: string;
  readonly fontSize: number;
  readonly rowHeight: number;
  readonly wordBreak: boolean;
}

// A <pre> would drop a leading newline, so whitespace is preserved on a plain <div>.
export function selectableSourceHtml(contents: string, style: SelectableSourceHtmlStyle): string {
  const text = contents.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
  const wrap = style.wordBreak
    ? "white-space:pre-wrap;overflow-wrap:anywhere"
    : "white-space:pre;width:max-content";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent}div{box-sizing:border-box;padding:8px 12px ${style.rowHeight}px;color:${style.foreground};font-family:monospace;font-size:${style.fontSize}px;line-height:${style.rowHeight / style.fontSize};${wrap}}::selection{background:color-mix(in srgb,${style.selection} 32%,transparent)}</style></head><body><div>${text}</div></body></html>`;
}
