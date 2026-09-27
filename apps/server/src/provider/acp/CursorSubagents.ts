import {
  RuntimeTaskId,
  type ProviderRuntimeTaskCompletedEvent,
  type ProviderRuntimeTaskProgressEvent,
  type ProviderRuntimeTaskStartedEvent,
  type TurnId,
} from "@t3tools/contracts";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

type TaskEvent =
  | Pick<ProviderRuntimeTaskStartedEvent, "type" | "payload" | "turnId">
  | Pick<ProviderRuntimeTaskProgressEvent, "type" | "payload" | "turnId">
  | Pick<ProviderRuntimeTaskCompletedEvent, "type" | "payload" | "turnId">;

export interface CursorSubagentRecord {
  readonly title: string;
  readonly role?: string;
  readonly phase: "pending" | "running" | "completed" | "failed";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Cursor ACP exposes a Task subagent as an ordinary tool whose raw input is `{_toolName:"task"}`. */
export function isCursorSubagentTool(rawInput: unknown): boolean {
  return text(record(rawInput)._toolName)?.toLowerCase() === "task";
}

function titleFor(toolCall: AcpToolCallState, rawInput: Record<string, unknown>): string {
  const described = text(rawInput.description);
  if (described) return described;
  const title = text(toolCall.title);
  if (!title) return "Subagent";
  const stripped = title.replace(/^Task:\s*/i, "").trim();
  return stripped.length > 0 ? stripped : "Subagent";
}

function roleFor(rawInput: Record<string, unknown>): string | undefined {
  return text(rawInput.subagentType) ?? text(rawInput.subagent_type);
}

function phaseFor(status: AcpToolCallState["status"]): CursorSubagentRecord["phase"] {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Project one Cursor Task tool call onto the task.* stream the Agents panel
 * already folds. Ordinary tools return no events. Child tool calls inside the
 * subagent are not tagged on the wire, so they stay on the parent transcript.
 */
export function cursorSubagentTaskEvents(input: {
  readonly tasks: Map<string, CursorSubagentRecord>;
  readonly toolCall: AcpToolCallState;
  readonly turnId: TurnId | undefined;
}): ReadonlyArray<TaskEvent> {
  const rawInput = record(input.toolCall.data.rawInput);
  if (!isCursorSubagentTool(rawInput)) return [];

  const previous = input.tasks.get(input.toolCall.toolCallId);
  if (previous?.phase === "completed" || previous?.phase === "failed") return [];

  const title = titleFor(input.toolCall, rawInput);
  const role = roleFor(rawInput) ?? previous?.role;
  const phase = phaseFor(input.toolCall.status);
  const linkage = {
    taskId: RuntimeTaskId.make(input.toolCall.toolCallId),
    taskType: "local_agent",
    toolUseId: input.toolCall.toolCallId,
    title,
    ...(role ? { role } : {}),
  };
  input.tasks.set(input.toolCall.toolCallId, { title, ...(role ? { role } : {}), phase });

  if (!previous) {
    const started: TaskEvent = {
      type: "task.started",
      turnId: input.turnId,
      payload: { ...linkage, description: title },
    };
    if (phase === "completed" || phase === "failed") {
      return [
        started,
        {
          type: "task.completed",
          turnId: input.turnId,
          payload: { ...linkage, status: phase, summary: title },
        },
      ];
    }
    return [started];
  }

  if (phase === "completed" || phase === "failed") {
    return [
      {
        type: "task.completed",
        turnId: input.turnId,
        payload: { ...linkage, status: phase, summary: title },
      },
    ];
  }

  if (previous.title === title && previous.role === role && previous.phase === phase) {
    return [];
  }
  return [
    {
      type: "task.progress",
      turnId: input.turnId,
      payload: {
        ...linkage,
        description: title,
        summary: title,
        status: phase === "pending" ? "pending" : "running",
      },
    },
  ];
}
