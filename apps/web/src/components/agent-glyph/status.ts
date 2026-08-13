import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import { deriveWorkLogEntries, workLogEntryIsToolLike } from "../../session-logic";
import type { AgentGlyphStatus } from "./poses.ts";

export type AgentGlyphToolHint = {
  readonly itemType?: string;
  readonly label?: string;
  readonly command?: string;
  readonly toolTitle?: string;
  readonly tone?: string;
  readonly toolLifecycleStatus?: string;
};

export type AgentGlyphStatusInput = {
  readonly sessionStatus: OrchestrationSession["status"] | null;
  readonly latestTurnState: OrchestrationLatestTurn["state"] | null;
  readonly isPreparing: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasThreadError: boolean;
  readonly reviewFocused: boolean;
  readonly lastTool: AgentGlyphToolHint | null;
};

const FILE_RE =
  /\b(write|edit|strreplace|str_replace|apply_?patch|file_change|search_replace|notebook_edit)\b/;
const TEST_RE =
  /\b(vitest|playwright|cypress|jest|pytest|vp test|npm test|pnpm test|yarn test|cargo test)\b/;
const UI_RE = /\b(screenshot|browser|computer-use|computer_use|puppeteer|image_view)\b/;
const WAIT_RE = /\b(ask_user|askuser|question|request_user|permission|user-input|user_input)\b/;
const REVIEW_RE = /\b(pull[_.\s-]?request|pr review|code review|review_pr)\b/;

function toolHaystack(tool: AgentGlyphToolHint): string {
  return [tool.itemType, tool.label, tool.command, tool.toolTitle]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
}

export function classifyToolHint(tool: AgentGlyphToolHint): AgentGlyphStatus | null {
  if (tool.tone === "error" || tool.toolLifecycleStatus === "failed") {
    return "debug";
  }

  const haystack = toolHaystack(tool);
  if (UI_RE.test(haystack) || tool.itemType === "image_view") return "ui-test";
  if (TEST_RE.test(haystack)) return "test";
  if (WAIT_RE.test(haystack)) return "wait";
  if (REVIEW_RE.test(haystack)) return "review";
  if (FILE_RE.test(haystack) || tool.itemType === "file_change") return "work";
  if (tool.itemType === "command_execution") return "work";
  if (tool.itemType === "web_search") return "think";
  if (tool.itemType === "mcp_tool_call" || tool.itemType === "dynamic_tool_call") return "work";
  return null;
}

export function resolveLastToolHint(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null,
): AgentGlyphToolHint | null {
  const entries = deriveWorkLogEntries(activities).filter((entry) => workLogEntryIsToolLike(entry));
  const scoped = turnId ? entries.filter((entry) => entry.turnId === turnId) : entries;
  let inProgress: (typeof scoped)[number] | undefined;
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const entry = scoped[index];
    if (entry?.toolLifecycleStatus === "inProgress") {
      inProgress = entry;
      break;
    }
  }
  const last = inProgress ?? scoped.at(-1);
  if (!last) return null;
  return {
    ...(last.itemType !== undefined ? { itemType: last.itemType } : {}),
    label: last.label,
    ...(last.command !== undefined ? { command: last.command } : {}),
    ...(last.toolTitle !== undefined ? { toolTitle: last.toolTitle } : {}),
    tone: last.tone,
    ...(last.toolLifecycleStatus !== undefined
      ? { toolLifecycleStatus: last.toolLifecycleStatus }
      : {}),
  };
}

/**
 * Bind the monogram to existing projected session / turn / tool signals.
 * Flutter is gated separately by `session.status === "running"` in the component.
 */
export function resolveAgentGlyphStatus(input: AgentGlyphStatusInput): AgentGlyphStatus {
  if (
    input.hasThreadError ||
    input.sessionStatus === "error" ||
    input.latestTurnState === "error"
  ) {
    return "debug";
  }
  if (input.hasPendingApproval || input.hasPendingUserInput) {
    return "wait";
  }

  const sessionRunning = input.sessionStatus === "running";
  if (sessionRunning || input.sessionStatus === "starting" || input.isPreparing) {
    const fromTool = input.lastTool ? classifyToolHint(input.lastTool) : null;
    if (fromTool) return fromTool;
    return "think";
  }

  if (input.reviewFocused) return "review";
  return "idle";
}
