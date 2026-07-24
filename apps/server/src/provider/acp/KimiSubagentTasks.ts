import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

/**
 * Detection and summary helpers for Kimi CLI sub-agent tool calls.
 *
 * The Kimi CLI reports its `Agent` / `AgentSwarm` tools over ACP as generic
 * (`kind: "other"`) tool calls: one `tool_call` (in_progress) followed by
 * `tool_call_update`s, with the tool arguments preserved in `rawInput` and the
 * final report in the terminal update's `rawOutput`. There is no nested
 * activity on the wire, so the adapter synthesizes the sub-agent lifecycle
 * (task.started / task.progress / task.completed) from these boundaries.
 */

export type KimiSubagentToolKind = "agent" | "agent_swarm";

export interface KimiSubagentTaskInfo {
  readonly kind: KimiSubagentToolKind;
  readonly subagentType: string;
  readonly description: string;
}

const DEFAULT_SUBAGENT_TYPE = "coder";
const SWARM_SUBAGENT_TYPE = "swarm";
const FALLBACK_DESCRIPTION = "Subagent task";
/** Keep terminal summaries bounded; full reports stay in the native event log. */
const SUMMARY_MAX_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Structural detection on the tool call's `rawInput`. The ACP title
 * ("Launching coder agent: …", bare "Agent" for the lazy path) is only used
 * as a description fallback, never as the detection signal.
 */
export function detectKimiSubagentToolCall(
  toolCall: Pick<AcpToolCallState, "title" | "data">,
): KimiSubagentTaskInfo | undefined {
  const rawInput = toolCall.data.rawInput;
  if (!isRecord(rawInput)) {
    return undefined;
  }
  if (Array.isArray(rawInput.items) && typeof rawInput.prompt_template === "string") {
    return {
      kind: "agent_swarm",
      subagentType: trimmedNonEmpty(rawInput.subagent_type) ?? SWARM_SUBAGENT_TYPE,
      description: trimmedNonEmpty(rawInput.description) ?? toolCall.title ?? FALLBACK_DESCRIPTION,
    };
  }
  if (
    typeof rawInput.prompt === "string" &&
    (typeof rawInput.description === "string" || rawInput.subagent_type !== undefined)
  ) {
    return {
      kind: "agent",
      subagentType: trimmedNonEmpty(rawInput.subagent_type) ?? DEFAULT_SUBAGENT_TYPE,
      description: trimmedNonEmpty(rawInput.description) ?? toolCall.title ?? FALLBACK_DESCRIPTION,
    };
  }
  return undefined;
}

function textFromAcpContentBlocks(value: ReadonlyArray<unknown>): string | undefined {
  const chunks: Array<string> = [];
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== "content" || !isRecord(entry.content)) {
      continue;
    }
    const text = trimmedNonEmpty(entry.content.text);
    if (text !== undefined) {
      chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

export function truncateSubagentSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, SUMMARY_MAX_LENGTH)}…`;
}

/**
 * Best-effort extraction of the sub-agent's final report from the terminal
 * update's `rawOutput`. The Kimi CLI passes the tool's output through
 * (`rawOutput: event.output`), which is a string for Agent tools, but tolerate
 * common object shapes so a CLI change degrades gracefully.
 */
export function extractSubagentSummary(rawOutput: unknown): string | undefined {
  const direct = trimmedNonEmpty(rawOutput);
  if (direct !== undefined) {
    return truncateSubagentSummary(direct);
  }
  if (!isRecord(rawOutput)) {
    return undefined;
  }
  const fromText = trimmedNonEmpty(rawOutput.text) ?? trimmedNonEmpty(rawOutput.report);
  if (fromText !== undefined) {
    return truncateSubagentSummary(fromText);
  }
  const content = rawOutput.content;
  const fromContent = trimmedNonEmpty(content);
  if (fromContent !== undefined) {
    return truncateSubagentSummary(fromContent);
  }
  if (Array.isArray(content)) {
    const fromBlocks = textFromAcpContentBlocks(content);
    if (fromBlocks !== undefined) {
      return truncateSubagentSummary(fromBlocks);
    }
  }
  return undefined;
}
