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
