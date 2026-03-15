import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { basenameOfPath } from "./vscode-icons";

export function buildThreadTitle(text: string, maxLength = 50): string {
  const normalized = splitPromptIntoComposerSegments(text)
    .map((segment) =>
      segment.type === "mention" ? `@${basenameOfPath(segment.path)}` : segment.text,
    )
    .join("")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}
