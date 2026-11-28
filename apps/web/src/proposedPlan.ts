import { displayedPlanMarkdown, proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { msg } from "gt-react";

import { m, type MessageResolver } from "./i18n/messages";

export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: {
    maxLines?: number;
  },
  resolve: MessageResolver = m,
): string {
  const maxLines = options?.maxLines ?? 8;
  const { markdown, separatorLine } = displayedPlanMarkdown(planMarkdown);
  const lines = markdown
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;
  let openFence: { marker: string; indent: string } | null = null;

  for (const [index, line] of lines.entries()) {
    const isVisibleLine = index !== separatorLine && line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) {
      visibleLineCount += 1;
    }
    const match = /^( {0,3})(?:(`{3,})[^`]*|(~{3,}).*)$/.exec(line);
    const fence = match?.[2] ?? match?.[3];
    if (match === null || fence === undefined) {
      continue;
    }
    if (openFence === null) {
      openFence = { marker: fence, indent: match[1] ?? "" };
    } else if (
      fence[0] === openFence.marker[0] &&
      fence.length >= openFence.marker.length &&
      line.trim() === fence
    ) {
      openFence = null;
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? resolve(msg("Plan preview unavailable."));
  }

  if (openFence !== null) {
    previewLines.push(openFence.indent + openFence.marker);
  }

  if (hasMoreContent) {
    previewLines.push("", "...");
  }

  return previewLines.join("\n");
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

export function downloadPlanAsTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
