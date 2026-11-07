// Pure helpers for ZeroClaw's spawn_subagent / delegate tool calls.
// Background delegate is a plain tool call, matching ZeroCode.

export interface ForegroundSubagentCall {
  readonly prompt: string;
  readonly title: string;
  readonly agents: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * A foreground subagent call, or `null` when the tool call should stay a plain
 * tool card. `background: true`, a non-delegate action, and an empty prompt
 * all return `null`.
 */
export function subagentCallFromToolCall(
  name: string,
  rawInput: unknown,
): ForegroundSubagentCall | null {
  if (!isRecord(rawInput)) return null;
  if (rawInput["background"] === true) return null;

  if (name === "spawn_subagent") {
    const prompt = stringField(rawInput, "prompt");
    if (prompt === undefined) return null;
    const agent = stringField(rawInput, "agent") ?? stringField(rawInput, "agent_alias");
    return {
      prompt,
      title: stringField(rawInput, "title") ?? agent ?? "subagent",
      agents: agent === undefined ? [] : [agent],
    };
  }

  if (name !== "delegate" || rawInput["action"] !== "delegate") return null;
  const prompt = stringField(rawInput, "prompt");
  if (prompt === undefined) return null;
  const agents = stringList(rawInput["parallel"]);
  const single = stringField(rawInput, "agent");
  const listed = agents.length > 0 ? agents : single === undefined ? [] : [single];
  return {
    prompt,
    title: listed.length > 0 ? listed.join(", ") : "delegate",
    agents: listed,
  };
}

export interface SubagentOutcome {
  readonly status: "completed" | "failed";
  readonly result: string | null;
}

export function subagentOutcomeFromToolResult(rawOutput: unknown): SubagentOutcome {
  if (typeof rawOutput === "string") {
    return { status: "completed", result: rawOutput.length > 0 ? rawOutput : null };
  }
  if (!isRecord(rawOutput)) return { status: "completed", result: null };
  const failed =
    rawOutput["status"] === "failed" || rawOutput["ok"] === false || rawOutput["isError"] === true;
  const result =
    stringField(rawOutput, "result") ??
    stringField(rawOutput, "output") ??
    stringField(rawOutput, "error") ??
    null;
  return { status: failed ? "failed" : "completed", result };
}
