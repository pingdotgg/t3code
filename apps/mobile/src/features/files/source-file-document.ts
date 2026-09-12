import type { ReviewHighlightedToken } from "../review/shikiReviewHighlighter";
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

// A selectable document cannot virtualize its rows. Cap React spans instead; large
// attachments remain fully selectable as one plain string, including every newline.
export function boundedSelectableSourceTokens(
  tokens: ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> | null,
): typeof tokens {
  if (!tokens) return null;
  let spans = tokens.length;
  for (const line of tokens) {
    spans += line.length;
    if (spans > 2_000) return null;
  }
  return tokens;
}
