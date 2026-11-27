import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";

const PREVIEW_LIMIT = 300;

export function errorDetailsPreview(details: string) {
  const firstLine = details.split("\n", 1)[0] ?? "";
  return firstLine.slice(
    0,
    splitsSurrogatePair(firstLine, PREVIEW_LIMIT) ? PREVIEW_LIMIT - 1 : PREVIEW_LIMIT,
  );
}
