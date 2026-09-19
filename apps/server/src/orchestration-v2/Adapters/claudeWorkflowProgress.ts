/**
 * Decoders for the Claude CLI's workflow telemetry.
 *
 * A `local_workflow` task reports its shape through `workflow_progress` on
 * `task_progress` — an array the SDK types do not declare, so every field is
 * read defensively and an unrecognised entry is dropped rather than failing
 * the frame. Two frame kinds arrive interleaved: snapshot frames carrying the
 * whole run, and usage-only frames carrying an empty array. Only a non-empty
 * array is authoritative; an empty one must leave the previous snapshot alone
 * or a live run would blink back to zero agents between ticks.
 */
import type {
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
  OrchestrationV2WorkflowPhase,
  OrchestrationV2WorkflowRunHandles,
} from "@t3tools/contracts";

import { field, text } from "../../orchestration/unknownField.ts";

export const CLAUDE_WORKFLOW_TASK_TYPE = "local_workflow";

const AGENT_STATES: Record<string, OrchestrationV2WorkflowAgent["state"] | undefined> = {
  queued: "queued",
  start: "running",
  done: "completed",
  error: "failed",
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

function parsePhase(entry: unknown): OrchestrationV2WorkflowPhase | null {
  const index = count(field(entry, "index"));
  const title = text(field(entry, "title"));
  return index === undefined || title === undefined ? null : { index, title };
}

function parseAgent(entry: unknown): OrchestrationV2WorkflowAgent | null {
  const index = count(field(entry, "index"));
  const label = text(field(entry, "label"));
  if (index === undefined || label === undefined) return null;
  // An unknown state is in-flight, not settled: guessing "completed" would
  // freeze a live row, while guessing "running" self-corrects on the next frame.
  const state = AGENT_STATES[text(field(entry, "state")) ?? ""] ?? "running";
  return {
    index,
    label,
    state,
    ...optional("agentId", text(field(entry, "agentId"))),
    ...optional("phaseIndex", count(field(entry, "phaseIndex"))),
    ...optional("phaseTitle", text(field(entry, "phaseTitle"))),
    ...optional("model", text(field(entry, "model"))),
    ...optional("attempt", count(field(entry, "attempt"))),
    ...optional("totalTokens", count(field(entry, "tokens"))),
    ...optional("toolCalls", count(field(entry, "toolCalls"))),
    ...optional("durationMs", count(field(entry, "durationMs"))),
    ...optional("queuedAt", count(field(entry, "queuedAt"))),
    ...optional("startedAt", count(field(entry, "startedAt"))),
    ...optional("prompt", text(field(entry, "promptPreview"))),
    ...optional("result", text(field(entry, "resultPreview"))),
  };
}

/**
 * Reads the Workflow tool's structured result. A background launch answers the
 * model with an acknowledgement rather than the run's output, and that
 * acknowledgement is the only place the run's filesystem handles appear —
 * nothing later on the event stream repeats them.
 */
export function parseClaudeWorkflowRunHandles(
  toolUseResult: unknown,
): OrchestrationV2WorkflowRunHandles | undefined {
  if (text(field(toolUseResult, "taskType")) !== CLAUDE_WORKFLOW_TASK_TYPE) return undefined;
  const handles = {
    ...optional("runId", text(field(toolUseResult, "runId"))),
    ...optional("transcriptDir", text(field(toolUseResult, "transcriptDir"))),
    ...optional("scriptPath", text(field(toolUseResult, "scriptPath"))),
  };
  return Object.keys(handles).length === 0 ? undefined : handles;
}

function parseClaudeWorkflowProgress(message: unknown): {
  readonly phases: ReadonlyArray<OrchestrationV2WorkflowPhase>;
  readonly agents: ReadonlyArray<OrchestrationV2WorkflowAgent>;
} | null {
  const entries = field(message, "workflow_progress");
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const phases: OrchestrationV2WorkflowPhase[] = [];
  const agents: OrchestrationV2WorkflowAgent[] = [];
  for (const entry of entries) {
    const type = text(field(entry, "type"));
    if (type === "workflow_phase") {
      const phase = parsePhase(entry);
      if (phase !== null) phases.push(phase);
    } else if (type === "workflow_agent") {
      const agent = parseAgent(entry);
      if (agent !== null) agents.push(agent);
    }
  }
  return phases.length === 0 && agents.length === 0 ? null : { phases, agents };
}

/**
 * Folds one frame into the coordinator's workflow state. A frame without a
 * snapshot still carries usage, so totals keep climbing between snapshots.
 * A phase only ever joins the plan — the provider re-sends the full plan on
 * every snapshot, but a late frame that omits an already-seen phase must not
 * shorten the arc the user is looking at.
 *
 * Returns undefined when nothing identifies the task as a workflow. Progress
 * frames do not repeat `task_type`, so this is the single place that decides
 * whether a task is a coordinator; without it every ordinary subagent's usage
 * frame would mint an empty workflow and render as a coordinator.
 */
export function mergeClaudeWorkflowProgress(input: {
  readonly previous: OrchestrationV2SubagentWorkflow | undefined;
  readonly name?: string | undefined;
  readonly runHandles?: OrchestrationV2WorkflowRunHandles | undefined;
  readonly message: unknown;
}): OrchestrationV2SubagentWorkflow | undefined {
  const { previous } = input;
  const snapshot = parseClaudeWorkflowProgress(input.message);
  if (
    previous === undefined &&
    input.name === undefined &&
    input.runHandles === undefined &&
    snapshot === null
  ) {
    return undefined;
  }
  const reported = field(input.message, "usage");
  const phasesByIndex = new Map(
    (previous?.phases ?? []).map((phase) => [phase.index, phase] as const),
  );
  for (const phase of snapshot?.phases ?? []) phasesByIndex.set(phase.index, phase);
  return {
    ...optional("name", input.name ?? previous?.name),
    ...optional("runHandles", input.runHandles ?? previous?.runHandles),
    phases: Array.from(phasesByIndex.values()).sort((left, right) => left.index - right.index),
    agents: snapshot?.agents ?? previous?.agents ?? [],
    ...optional("totalTokens", count(field(reported, "total_tokens")) ?? previous?.totalTokens),
    ...optional("toolCalls", count(field(reported, "tool_uses")) ?? previous?.toolCalls),
    ...optional("durationMs", count(field(reported, "duration_ms")) ?? previous?.durationMs),
  };
}
