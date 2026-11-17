import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as DateTime from "effect/DateTime";

import { FEEDBACK_TRACE_TURNS, type FeedbackTrace } from "./FeedbackReport.ts";
import { scrubFeedback } from "./scrubFeedback.ts";

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
const T3_PREFIX = /^(?:mcp__t3[-_]?code(?:[-_]direct)?__|t3[-_]?code(?:[-_]direct)?[.:/])/iu;
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
  const t3 = resolveT3McpToolId(name) ?? name.replace(T3_PREFIX, "");
  if (t3Tools.includes(t3)) return t3;
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

/**
 * The outline of the last few started turns: who spoke and which tools ran, with no text, input,
 * or output. With `includeTurns`, the scrubbed message text of that many of the newest turns.
 */
export const buildFeedbackTrace = (input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly includeTurns: number;
  readonly sensitive: ReadonlyArray<string>;
  readonly t3Tools: ReadonlyArray<string>;
  readonly driverOf: (run: OrchestrationV2Run) => string | undefined;
}): FeedbackTrace => {
  const runs = input.runs
    .filter((run) => run.startedAt !== null)
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .slice(-FEEDBACK_TRACE_TURNS);
  const turnOf = new Map(runs.map((run, index) => [run.id, { turn: index + 1, run }] as const));
  const firstTextTurn = runs.length - input.includeTurns + 1;
  let truncated = false;
  const entries = input.items
    .filter((item) => item.parentItemId === null && item.runId !== null && turnOf.has(item.runId))
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
        if (length > MAX_TEXT_CHARS) truncated = true;
        return { ...message, text: scrubFeedback(item.text, input.sensitive, MAX_TEXT_CHARS) };
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
