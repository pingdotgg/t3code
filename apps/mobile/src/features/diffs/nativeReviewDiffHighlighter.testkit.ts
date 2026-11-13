// Shared fixtures for nativeReviewDiffHighlighter.test.ts.
export const TYPESCRIPT_FILE: NativeReviewDiffFile = {
  id: "file-1",
  path: "example.ts",
  language: "typescript",
  additions: 0,
  deletions: 0,
};

export function makeLine(
  input: Pick<NativeReviewDiffRow, "id" | "content" | "change" | "oldLineNumber" | "newLineNumber">,
): NativeReviewDiffRow {
  return {
    kind: "line",
    fileId: TYPESCRIPT_FILE.id,
    ...input,
  };
}

export function makeHunk(id: string): NativeReviewDiffRow {
  return {
    kind: "hunk",
    id,
    fileId: TYPESCRIPT_FILE.id,
    text: "@@",
  };
}

import { highlightCode } from "../../lib/highlights";

import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";

export const OLD_SOURCE = [
  "export function render(name: string) {",
  "  const heading = `Hello ${name}",
  "Welcome to the archive.",
  "Your saved reports follow.",
  "  `;",
  "  /* Historical formatting rules:",
  "   * Keep the title and summary together.",
  "   * Preserve links in the footer.",
  "   */",
  "  return heading.trim();",
  "}",
];
export const NEW_SOURCE = [
  "export function render(name: string) {",
  "  const heading = `Greetings ${name}",
  "Welcome to the workspace.",
  "Your saved reports follow.",
  "  `;",
  "  /* Current formatting rules:",
  "   * Keep the title and summary together.",
  "   * Highlight links in the footer.",
  "   */",
  "  return heading.trim();",
  "}",
];

export function authoritativeTokens(source: ReadonlyArray<string>) {
  return highlightCode(source.join("\n"), "typescript", "dark");
}

export function sourceRow(change: "context" | "add" | "delete", lineNumber: number) {
  return makeLine({
    id: `${change}-${lineNumber}`,
    content: (change === "delete" ? OLD_SOURCE : NEW_SOURCE)[lineNumber - 1]!,
    change,
    oldLineNumber: change === "add" ? null : lineNumber,
    newLineNumber: change === "delete" ? null : lineNumber,
  });
}

export function completeDiffRows() {
  return [
    sourceRow("context", 1),
    sourceRow("delete", 2),
    sourceRow("delete", 3),
    sourceRow("add", 2),
    sourceRow("add", 3),
    sourceRow("context", 4),
    sourceRow("context", 5),
    sourceRow("delete", 6),
    sourceRow("add", 6),
    sourceRow("context", 7),
    sourceRow("delete", 8),
    sourceRow("add", 8),
    sourceRow("context", 9),
    sourceRow("context", 10),
    sourceRow("context", 11),
  ];
}
