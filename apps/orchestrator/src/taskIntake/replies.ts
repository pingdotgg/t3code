import type { TaskIntakeMessage, TaskIntakeReply } from "./contracts.ts";

function replyBase(input: {
  readonly message: TaskIntakeMessage;
  readonly body: string;
  readonly suffix: string;
}): TaskIntakeReply {
  return {
    source: input.message.source,
    conversation: input.message.conversation,
    body: input.body,
    idempotencyKey: `${input.message.eventId}:${input.suffix}`,
  };
}

export function buildTaskIntakeNeedsInputReply(input: {
  readonly message: TaskIntakeMessage;
  readonly reason?: string;
}): TaskIntakeReply {
  return replyBase({
    message: input.message,
    suffix: "needs-input",
    body: [
      "I can help with this, but I need a clearer coding task before I start.",
      "",
      input.reason ?? "Please send the repo change, bug, or investigation you want handled.",
    ].join("\n"),
  });
}

export function buildTaskIntakeAcceptedReply(input: {
  readonly message: TaskIntakeMessage;
  readonly taskId: string;
  readonly t3ThreadId?: string;
  readonly branch?: string | null;
}): TaskIntakeReply {
  return replyBase({
    message: input.message,
    suffix: "accepted",
    body: [
      `Task ${input.taskId} is underway.`,
      ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
      ...(input.branch ? [`Branch: \`${input.branch}\``] : []),
    ].join("\n"),
  });
}

export function buildTaskIntakeFollowUpReply(input: {
  readonly message: TaskIntakeMessage;
  readonly taskId: string;
  readonly t3ThreadId?: string;
}): TaskIntakeReply {
  return replyBase({
    message: input.message,
    suffix: "follow-up",
    body: [
      `Got it. I routed this follow-up to Task ${input.taskId}.`,
      ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
    ].join("\n"),
  });
}

export function buildTaskIntakeStartFailedReply(input: {
  readonly message: TaskIntakeMessage;
  readonly taskId?: string;
  readonly summary: string;
}): TaskIntakeReply {
  return replyBase({
    message: input.message,
    suffix: "start-failed",
    body: [
      input.taskId === undefined
        ? "I could not start a T3 task for this request."
        : `I could not start Task ${input.taskId}.`,
      "",
      `Failure summary: ${input.summary}`,
    ].join("\n"),
  });
}

export function buildTaskIntakeLifecycleReply(input: {
  readonly message: TaskIntakeMessage;
  readonly status: "completed" | "failed";
  readonly taskId: string;
  readonly t3ThreadId?: string;
  readonly failureSummary?: string;
}): TaskIntakeReply {
  if (input.status === "completed") {
    return replyBase({
      message: input.message,
      suffix: "completed",
      body: [
        `Task ${input.taskId} completed.`,
        ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
        "Detailed output lives in T3 for this MVP.",
      ].join("\n"),
    });
  }

  return replyBase({
    message: input.message,
    suffix: "failed",
    body: [
      `Task ${input.taskId} failed.`,
      ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
      `Failure summary: ${input.failureSummary?.trim() || "Unknown error"}`,
    ].join("\n"),
  });
}
