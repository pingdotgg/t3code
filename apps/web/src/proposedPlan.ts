export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

export interface ProposedPlanTask {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

interface ProposedPlanTaskGroup {
  heading: string | null;
  explicitTaskCount: number;
  tasks: ProposedPlanTask[];
}

const TASK_SECTION_HEADING =
  /^(?:implementation(?: plan)?|execution(?: plan)?|plan|steps?|tasks?|work plan)$/i;

function normalizeProposedPlanTaskText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractProposedPlanTasks(planMarkdown: string): ProposedPlanTask[] {
  const groups: ProposedPlanTaskGroup[] = [];
  let heading: string | null = null;
  let currentGroup: ProposedPlanTaskGroup | null = null;
  let fenced = false;

  const finishGroup = () => {
    if (currentGroup?.tasks.length) {
      groups.push(currentGroup);
    }
    currentGroup = null;
  };

  for (const line of planMarkdown.split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      finishGroup();
      continue;
    }
    if (fenced) {
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      finishGroup();
      heading = normalizeProposedPlanTaskText(headingMatch[1] ?? "") || null;
      continue;
    }

    const itemMatch = line.match(/^\s{0,3}(?:[-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/);
    if (itemMatch) {
      const step = normalizeProposedPlanTaskText(itemMatch[2] ?? "");
      if (!step) {
        continue;
      }
      currentGroup ??= {
        heading,
        explicitTaskCount: 0,
        tasks: [],
      };
      const marker = itemMatch[1];
      if (marker !== undefined) {
        currentGroup.explicitTaskCount += 1;
      }
      currentGroup.tasks.push({
        step,
        status: marker?.toLowerCase() === "x" ? "completed" : "pending",
      });
      continue;
    }

    if (line.trim().length > 0 && !/^\s{4,}/.test(line)) {
      finishGroup();
    }
  }
  finishGroup();

  const rankedGroups = groups.toSorted((left, right) => {
    const headingDifference =
      Number(TASK_SECTION_HEADING.test(right.heading ?? "")) -
      Number(TASK_SECTION_HEADING.test(left.heading ?? ""));
    if (headingDifference !== 0) {
      return headingDifference;
    }
    const explicitDifference = right.explicitTaskCount - left.explicitTaskCount;
    if (explicitDifference !== 0) {
      return explicitDifference;
    }
    return right.tasks.length - left.tasks.length;
  });

  return rankedGroups[0]?.tasks ?? [];
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift();
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift();
    }
  }
  return sourceLines.join("\n");
}

export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: {
    maxLines?: number;
  },
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;

  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) {
      visibleLineCount += 1;
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
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

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

export function resolvePlanFollowUpSubmission(input: { draftText: string; planMarkdown: string }): {
  text: string;
  interactionMode: "default" | "plan";
} {
  const trimmedDraftText = input.draftText.trim();
  if (trimmedDraftText.length > 0) {
    return {
      text: trimmedDraftText,
      interactionMode: "plan",
    };
  }

  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default",
  };
}

export function buildPlanImplementationThreadTitle(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  if (!title) {
    return "Implement plan";
  }
  return `Implement ${title}`;
}

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
