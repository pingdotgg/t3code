import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { FEEDBACK_TRACE_TURNS, type FeedbackTrace, resolveT3ToolName } from "./FeedbackReport.ts";
import { scrubFeedbackText } from "./scrubFeedback.ts";

const MAX_ENTRIES = 80;
const MAX_TEXT_CHARS = 1_000;
// Keeps one `agent.feedback` event small next to the 20 a telemetry batch holds.
const FEEDBACK_TRACE_MAX_BYTES = 16_000;

export const FEEDBACK_TRACE_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "dynamic_tool",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

// Claude and Codex namespace or mark tools from other MCP servers; other harnesses name them
// like built-ins, so there every tool that is not T3's could be one.
const NAMES_BUILT_IN_TOOLS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);
const BUILT_IN_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
/** Every tool from the user's other MCP servers, whose names describe their setup. */
const OTHER_TOOL = "mcp";

type Entry = FeedbackTrace["entries"][number];

const toolName = (
  item: OrchestrationV2TurnItem,
  t3Tools: ReadonlyArray<string>,
  namesBuiltIns: boolean,
): string => {
  if (item.type === "command_execution") return "shell";
  if (item.type !== "dynamic_tool") return item.type;
  const name = item.toolName ?? "";
  const t3 = resolveT3ToolName(name, t3Tools);
  if (t3 !== undefined) return t3;
  return namesBuiltIns &&
    item.toolSource?.kind !== "integration" &&
    !/^mcp/iu.test(name) &&
    BUILT_IN_NAME.test(name)
    ? name
    : OTHER_TOOL;
};

const outcome = (item: OrchestrationV2TurnItem): NonNullable<Entry["outcome"]> => {
  if (item.status === "failed") return "error";
  if (item.status !== "completed") return "unfinished";
  return item.type === "command_execution" &&
    ((item.exitCode ?? 0) !== 0 || item.outputIndicatesFailure === true)
    ? "error"
    : "ok";
};

const bytes = (trace: FeedbackTrace) => Buffer.byteLength(JSON.stringify(trace));

/** Started turns outlined for a report spanning `turns`. No more than the entry cap could fit. */
export const feedbackTraceWindow = (turns: number) =>
  Math.min(Math.max(FEEDBACK_TRACE_TURNS, turns), MAX_ENTRIES);

/**
 * The outline of the last few started turns: who spoke and which tools ran, with no text, input,
 * or output. With `withText`, also the scrubbed message text of the last `turns` of them.
 */
export const buildFeedbackTrace = (input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly turns: number;
  readonly withText: boolean;
  readonly sensitive: ReadonlyArray<string>;
  readonly t3Tools: ReadonlyArray<string>;
  readonly driverOf: (run: OrchestrationV2Run) => string | undefined;
  readonly submittingRunId: OrchestrationV2Run["id"];
}): FeedbackTrace => {
  const window = feedbackTraceWindow(input.turns);
  const started = input.runs
    .filter((run) => run.startedAt !== null)
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const runs = started.slice(-window);
  const firstTextTurn = input.withText ? runs.length - input.turns + 1 : Infinity;
  const turnOf = new Map(runs.map((run, index) => [run.id, { turn: index + 1, run }] as const));
  // The `t3_feedback` call making this report is still running; listed, it reads as a hung call.
  const submitting = (item: OrchestrationV2TurnItem) =>
    item.runId === input.submittingRunId &&
    item.type === "dynamic_tool" &&
    outcome(item) === "unfinished" &&
    resolveT3ToolName(item.toolName ?? "", input.t3Tools) === "t3_feedback";
  // Asked for more turns than the window holds, in a thread long enough to have them.
  let truncated = input.turns > window && started.length >= window;
  const entries = input.items
    .filter(
      (item) =>
        item.parentItemId === null &&
        item.runId !== null &&
        turnOf.has(item.runId) &&
        !submitting(item),
    )
    .map((item) => ({ item, ...turnOf.get(item.runId!)! }))
    .toSorted((a, b) => a.turn - b.turn || a.item.ordinal - b.item.ordinal)
    .map(({ item, turn, run }): Entry => {
      if (item.type === "user_message" || item.type === "assistant_message") {
        const length = Array.from(item.text).length;
        const message: Entry = {
          turn,
          type: item.type === "user_message" ? "user" : "assistant",
          length,
        };
        if (turn < firstTextTurn) return message;
        const { text, cut } = scrubFeedbackText(item.text, input.sensitive, MAX_TEXT_CHARS);
        if (cut) truncated = true;
        return { ...message, text };
      }
      const started = item.startedAt;
      const completed = item.completedAt;
      return {
        turn,
        type: "tool",
        tool: toolName(item, input.t3Tools, NAMES_BUILT_IN_TOOLS.has(input.driverOf(run) ?? "")),
        outcome: outcome(item),
        ...(started !== null && completed !== null
          ? {
              durationMs: Math.max(
                0,
                DateTime.toEpochMillis(completed) - DateTime.toEpochMillis(started),
              ),
            }
          : {}),
      };
    });

  // Tool calls go first, oldest first, so the messages of every turn stay.
  while (entries.length > MAX_ENTRIES) {
    const tool = entries.findIndex((entry) => entry.type === "tool");
    entries.splice(tool === -1 ? 0 : tool, 1);
    truncated = true;
  }
  const trace = (): FeedbackTrace => ({
    turns: runs.length,
    textTurns: new Set(entries.filter((entry) => entry.text !== undefined).map((e) => e.turn)).size,
    truncated,
    entries,
  });
  while (bytes(trace()) > FEEDBACK_TRACE_MAX_BYTES) {
    truncated = true;
    const withText = entries.findIndex((entry) => entry.text !== undefined);
    if (withText === -1) entries.shift();
    else {
      const { text: _dropped, ...rest } = entries[withText]!;
      entries[withText] = rest;
    }
  }
  return trace();
};
