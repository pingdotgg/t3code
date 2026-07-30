import { formatInlineCodeContextLabel as formatInlineCodeContextSelectionLabel } from "~/lib/codeContext";

export function buildInlineCodeContextText(
  contexts: ReadonlyArray<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
  }>,
): string {
  return contexts.map((context) => formatInlineCodeContextLabel(context)).join(" ");
}

export function formatInlineCodeContextLabel(context: {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return formatInlineCodeContextSelectionLabel(context);
}

export function textContainsInlineCodeContextLabels(
  text: string,
  contexts: ReadonlyArray<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
  }>,
): boolean {
  let searchStartIndex = 0;

  for (const context of contexts) {
    const label = formatInlineCodeContextLabel(context);
    const matchIndex = text.indexOf(label, searchStartIndex);
    if (matchIndex === -1) {
      return false;
    }
    searchStartIndex = matchIndex + label.length;
  }

  return true;
}
