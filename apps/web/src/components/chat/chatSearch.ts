import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString as mdastToString } from "mdast-util-to-string";

import {
  type TimelineEntry,
  type WorkLogEntry,
  workEntryIndicatesToolNeutralStatus,
} from "../../session-logic";

export type MatchField = "text" | "plan" | "label" | "detail" | "command" | "toolTitle";

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

/** Projects markdown to the plain text react-markdown will render (best-effort). */
function projectMarkdown(markdown: string): string {
  if (markdown.trim().length === 0) return "";
  return mdastToString(markdownProcessor.parse(markdown));
}

function workFields(entry: WorkLogEntry): Array<{ field: MatchField; text: string }> {
  const units: Array<{ field: MatchField; text: string }> = [];
  const push = (field: MatchField, value: string | undefined) => {
    if (value && value.trim().length > 0) units.push({ field, text: value });
  };
  push("label", entry.label);
  push("detail", entry.detail);
  push("command", entry.command);
  push("toolTitle", entry.toolTitle);
  return units;
}

export function projectEntryText(entry: TimelineEntry): Array<{ field: MatchField; text: string }> {
  switch (entry.kind) {
    case "message": {
      const text = projectMarkdown(entry.message.text);
      return text.length > 0 ? [{ field: "text", text }] : [];
    }
    case "proposed-plan": {
      const text = projectMarkdown(entry.proposedPlan.planMarkdown);
      return text.length > 0 ? [{ field: "plan", text }] : [];
    }
    case "work": {
      // Honesty filter: never index work entries the renderer drops.
      if (workEntryIndicatesToolNeutralStatus(entry.entry)) return [];
      return workFields(entry.entry);
    }
  }
}
