import type { T3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";

export interface T3ToolSummaryCall {
  readonly input: unknown;
  readonly output: unknown;
  readonly outcome: "completed" | "failed" | "unfinished";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface ToolResult {
  readonly data?: Record<string, unknown>;
  readonly failed: boolean;
}

/** Reads the structured/JSON MCP result envelopes retained by the provider adapters. */
function readResult(value: unknown, depth = 0): ToolResult {
  if (depth > 4) return { failed: false };
  if (typeof value === "string") {
    try {
      return readResult(JSON.parse(value), depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    let data: ToolResult["data"];
    let failed = false;
    for (const block of value) {
      const text = asRecord(block)?.text;
      const result = readResult(asRecord(text)?.text ?? text, depth + 1);
      data ??= result.data;
      failed ||= result.failed;
    }
    return { ...(data ? { data } : {}), failed };
  }
  const record = asRecord(value);
  if (!record) return { failed: false };
  const failed =
    record.isError === true ||
    record.is_error === true ||
    record._tag === "OrchestratorMcpFailure" ||
    record.error != null;
  const content = record.structuredContent ?? record.content;
  if (content !== undefined) {
    const result = readResult(content, depth + 1);
    return { ...(result.data ? { data: result.data } : {}), failed: failed || result.failed };
  }
  return { data: record, failed };
}

function readInput(value: unknown): Record<string, unknown> | undefined {
  const input = readResult(value).data;
  // Cursor retains its MCP args envelope; other adapters retain the arguments directly.
  return input && typeof input.toolName === "string" ? asRecord(input.args) : input;
}

function countEntities(ids: ReadonlyArray<string | undefined>): number {
  return (
    new Set(ids.filter((value) => value !== undefined)).size +
    ids.filter((value) => value === undefined).length
  );
}

function quantity(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Counts successful effects separately from failed or unfinished tool calls. */
export function summarizeT3ToolCalls(
  action: T3McpToolSummaryAction,
  calls: ReadonlyArray<T3ToolSummaryCall>,
): { label: string; failedCount: number; unfinishedCount: number } {
  const results = calls.map((call) => {
    const result = readResult(call.output);
    return {
      input: readInput(call.input),
      output: result.data,
      outcome: result.failed ? ("failed" as const) : call.outcome,
    };
  });
  const completed = results.filter((call) => call.outcome === "completed");
  const failedCount = results.filter((call) => call.outcome === "failed").length;
  const unfinishedCount = results.filter((call) => call.outcome === "unfinished").length;
  const selected = completed.length > 0 ? completed : results;
  const times = quantity(selected.length, "time");
  const phrase = (past: string, infinitive: string, object: string) =>
    `${completed.length > 0 ? past : `Tried to ${infinitive}`} ${object}`;
  const entityIds = (key: string) =>
    selected.map((call) => id(call.output?.[key]) ?? id(call.input?.[key]));
  const threadIds = selected.map(
    (call) =>
      id(call.output?.threadId) ??
      id(asRecord(call.output?.thread)?.threadId) ??
      id(call.input?.threadId),
  );
  let label: string;
  switch (action) {
    case "thread-send": {
      const messages = countEntities(selected.map((call) => id(call.output?.messageId)));
      const targetsKnown = threadIds.every((value) => value !== undefined);
      const threads = new Set(threadIds).size;
      const object = targetsKnown
        ? messages === threads && messages > 1
          ? `messages to ${quantity(threads, "thread")}`
          : `${quantity(messages, "message")} to ${quantity(threads, "thread")}`
        : quantity(messages, "message");
      label = phrase("Sent", "send", object);
      break;
    }
    case "thread-create": {
      const createdIds: string[] = [];
      const resultsKnown =
        completed.length > 0 &&
        completed.every((call) => {
          const threads = Array.isArray(call.output?.threads) ? call.output.threads : [call.output];
          return threads.every((thread) => {
            const record = asRecord(thread);
            if (record?.status === "rolled_back") return true;
            const threadId = id(record?.threadId);
            if (!threadId) return false;
            createdIds.push(threadId);
            return true;
          });
        });
      label = resultsKnown
        ? `Created ${quantity(new Set(createdIds).size, "thread")}`
        : `Requested thread creation ${times}`;
      break;
    }
    case "delegate":
      label = phrase("Delegated", "delegate", quantity(countEntities(entityIds("taskId")), "task"));
      break;
    case "thread-read":
    case "thread-wait": {
      const targets = threadIds.every((value) => value !== undefined)
        ? quantity(new Set(threadIds).size, "thread")
        : `threads ${times}`;
      label =
        action === "thread-read"
          ? phrase("Read", "read", targets)
          : phrase("Waited on", "wait on", targets);
      break;
    }
    case "thread-list":
      label = phrase("Listed", "list", `threads ${times}`);
      break;
    case "thread-interrupt":
      label = `Requested interrupts for ${quantity(countEntities(threadIds), "thread")}`;
      break;
    case "task-status":
      label = phrase("Checked", "check", `task status ${times}`);
      break;
    case "task-cancel":
      label = `Requested cancellation of ${quantity(countEntities(entityIds("taskId")), "task")}`;
      break;
    case "schedule-create":
      label = phrase(
        "Scheduled",
        "schedule",
        quantity(countEntities(entityIds("scheduledTaskId")), "task"),
      );
      break;
    case "schedule-list":
      label = phrase("Listed", "list", `scheduled tasks ${times}`);
      break;
    case "schedule-update":
      label = phrase(
        "Updated",
        "update",
        quantity(countEntities(entityIds("scheduledTaskId")), "scheduled task"),
      );
      break;
    case "schedule-delete":
      // A successful delete can report deleted:false; it still represents a deletion request.
      label = `Requested deletion of ${quantity(countEntities(entityIds("scheduledTaskId")), "scheduled task")}`;
      break;
    case "capabilities":
      label = phrase("Checked", "check", `orchestration capabilities ${times}`);
      break;
  }
  return { label, failedCount, unfinishedCount };
}
