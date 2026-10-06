import {
  NonNegativeInt,
  WORKFLOW_MAX_PHASES,
  WORKFLOW_MAX_AGENTS,
  TrimmedNonEmptyString,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
  type OrchestrationV2WorkflowPhase,
  type OrchestrationV2WorkflowRunHandles,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Workflow telemetry is not declared in the SDK. Decode entries independently:
// one newer or malformed entry must not discard the rest of the snapshot.
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeText = Schema.decodeUnknownOption(TrimmedNonEmptyString.check(Schema.isMaxLength(512)));
const decodePath = Schema.decodeUnknownOption(
  TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
);
const decodeCount = Schema.decodeUnknownOption(NonNegativeInt);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  Option.getOrElse(decodeRecord(value), () => ({}));
const text = (value: unknown) => Option.getOrUndefined(decodeText(value));
const count = (value: unknown) => Option.getOrUndefined(decodeCount(value));
const excerpt = (value: unknown) =>
  typeof value === "string" && value.length <= 1_024 && value.trim().length > 0 ? value : undefined;
const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : { [key]: value };

const agentStates: Readonly<Record<string, OrchestrationV2WorkflowAgent["state"]>> = {
  queued: "queued",
  start: "running",
  done: "completed",
  error: "failed",
};

function parseAgent(entry: ReturnType<typeof record>): OrchestrationV2WorkflowAgent | undefined {
  const index = count(entry.index);
  const label = text(entry.label);
  if (index === undefined || label === undefined) return undefined;
  return {
    index,
    label,
    state: agentStates[text(entry.state) ?? ""] ?? "running",
    ...optional("agentId", text(entry.agentId)),
    ...optional("phaseIndex", count(entry.phaseIndex)),
    ...optional("phaseTitle", text(entry.phaseTitle)),
    ...optional("model", text(entry.model)),
    ...optional("lastToolName", text(entry.lastToolName)),
    ...optional("attempt", count(entry.attempt)),
    ...optional("totalTokens", count(entry.tokens)),
    ...optional("toolCalls", count(entry.toolCalls)),
    ...optional("durationMs", count(entry.durationMs)),
    ...optional("queuedAt", count(entry.queuedAt)),
    ...optional("startedAt", count(entry.startedAt)),
    ...optional("prompt", excerpt(entry.promptPreview)),
    ...optional("result", excerpt(entry.resultPreview)),
  };
}

/** Launch acknowledgements are the only frames containing the run's file handles. */
export function parseClaudeWorkflowRunHandles(
  value: unknown,
): OrchestrationV2WorkflowRunHandles | undefined {
  const entry = record(value);
  if (entry.taskType !== "local_workflow") return undefined;
  const handles = {
    ...optional("runId", text(entry.runId)),
    ...optional("transcriptDir", Option.getOrUndefined(decodePath(entry.transcriptDir))),
    ...optional("scriptPath", Option.getOrUndefined(decodePath(entry.scriptPath))),
  };
  return Object.keys(handles).length === 0 ? undefined : handles;
}

/** Usage-only frames carry an empty roster. Retain members and the discovered phase plan. */
export function mergeClaudeWorkflowProgress(input: {
  readonly previous: OrchestrationV2SubagentWorkflow | undefined;
  readonly message?: unknown;
  readonly runHandles?: OrchestrationV2WorkflowRunHandles | undefined;
}): OrchestrationV2SubagentWorkflow | undefined {
  const { previous } = input;
  const message = record(input.message);
  const phases = new Map<number, OrchestrationV2WorkflowPhase>(
    previous?.phases.map((phase) => [phase.index, phase]),
  );
  const agents = new Map<number, OrchestrationV2WorkflowAgent>(
    previous?.agents.map((agent) => [agent.index, agent]),
  );
  let truncated = previous?.truncated ?? false;
  if (Array.isArray(message.workflow_progress)) {
    for (const value of message.workflow_progress) {
      const entry = record(value);
      if (entry.type === "workflow_phase") {
        const index = count(entry.index);
        const title = text(entry.title);
        if (index !== undefined && title !== undefined) {
          if (phases.has(index) || phases.size < WORKFLOW_MAX_PHASES)
            phases.set(index, { index, title });
          else truncated = true;
        }
      } else if (entry.type === "workflow_agent") {
        const agent = parseAgent(entry);
        if (agent === undefined) continue;
        const prior = agents.get(agent.index);
        if (prior === undefined && agents.size >= WORKFLOW_MAX_AGENTS) {
          truncated = true;
          continue;
        }
        const attempt = agent.attempt ?? prior?.attempt ?? 1;
        if (prior !== undefined && attempt < (prior.attempt ?? 1)) continue;
        const restarted = prior !== undefined && attempt > (prior.attempt ?? 1);
        // Regressed snapshots may fill missing fields, not overwrite settled data.
        const regressed =
          !restarted &&
          (((prior?.state === "completed" || prior?.state === "failed") &&
            agent.state !== prior.state) ||
            (prior?.state === "running" && agent.state === "queued"));
        agents.set(
          agent.index,
          regressed
            ? { ...agent, ...prior }
            : {
                ...(restarted
                  ? {
                      ...optional("phaseIndex", prior.phaseIndex),
                      ...optional("phaseTitle", prior.phaseTitle),
                    }
                  : prior),
                ...agent,
              },
        );
      }
    }
  }
  if (
    previous === undefined &&
    message.task_type !== "local_workflow" &&
    input.runHandles === undefined &&
    phases.size === 0 &&
    agents.size === 0
  ) {
    return undefined;
  }
  const usage = record(message.usage);
  const name = text(message.workflow_name) ?? previous?.name;
  const runHandles =
    input.runHandles === undefined
      ? previous?.runHandles
      : { ...previous?.runHandles, ...input.runHandles };
  return {
    ...optional("name", name),
    ...optional("launchMessageId", previous?.launchMessageId),
    ...(truncated ? { truncated: true } : {}),
    ...optional("runHandles", runHandles),
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    ...optional("totalTokens", count(usage.total_tokens) ?? previous?.totalTokens),
    ...optional("toolCalls", count(usage.tool_uses) ?? previous?.toolCalls),
    ...optional("durationMs", count(usage.duration_ms) ?? previous?.durationMs),
  };
}
