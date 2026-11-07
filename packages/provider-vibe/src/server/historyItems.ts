import type { OrchestrationV2TurnItem, OrchestrationV2TurnItemStatus } from "@t3tools/contracts";

type HistoryItemBase = Omit<
  Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
  "type" | "toolName" | "input" | "output" | "status" | "title"
>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// Search output stays on the timeline wire, so keep it a preview.
const SEARCH_PREVIEW_MAX_CHARS = 8_000;

const EFFECT_STATUS: Record<string, OrchestrationV2TurnItemStatus> = {
  pending: "pending",
  running: "running",
  blocked: "waiting",
  completed: "completed",
  skipped: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/** Whether a Vibe effect state is terminal, so the item gets a `completedAt`. */
export function vibeEffectSettled(entry: Record<string, unknown>): boolean {
  const status = str(asRecord(entry["state"])?.["status"]);
  return (
    status !== undefined && status !== "pending" && status !== "running" && status !== "blocked"
  );
}

function effectOutput(state: Record<string, unknown> | undefined): string | undefined {
  const outputText = text(state?.["outputText"]);
  if (outputText) return outputText;
  const output = state?.["output"];
  const record = asRecord(output);
  const shellOutput =
    text(record?.["output"]) ||
    [text(record?.["stdout"]), text(record?.["stderr"])].filter(Boolean).join("\n");
  if (shellOutput) return shellOutput;
  if (output === null || output === undefined) {
    return str(asRecord(state?.["error"])?.["message"]) ?? str(state?.["reason"]);
  }
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

/**
 * Projects a non-message Vibe history entry (`reasoning` or `effect`) to a turn item.
 * Returns undefined for entries the timeline does not show (callbacks, notices, checkpoints).
 */
export function vibeHistoryTurnItem(
  base: HistoryItemBase,
  entry: Record<string, unknown>,
): OrchestrationV2TurnItem | undefined {
  if (entry["type"] === "reasoning") {
    const reasoning = text(entry["text"]);
    if (!reasoning) return undefined;
    return {
      ...base,
      status: "completed",
      title: null,
      type: "reasoning",
      text: reasoning,
      streaming: false,
    };
  }
  if (entry["type"] !== "effect") return undefined;

  const detail = asRecord(entry["detail"]);
  const state = asRecord(entry["state"]);
  const input = asRecord(detail?.["input"]);
  // Vibe names MCP tools `mcp_<server>.<tool>`; T3's tool labels expect `mcp__<server>__<tool>`.
  const toolName = str(detail?.["toolName"])?.replace(/^mcp_([^.]+)\.(.+)$/, "mcp__$1__$2") ?? null;
  const status = EFFECT_STATUS[str(state?.["status"]) ?? ""] ?? "running";
  const title = str(asRecord(detail?.["display"])?.["summary"]) ?? str(entry["title"]) ?? null;
  const output = effectOutput(state);
  const common = { ...base, status, title };

  switch (str(detail?.["kind"])) {
    case "shell": {
      const exitCode = asRecord(state?.["output"])?.["exitCode"];
      return {
        ...common,
        type: "command_execution",
        input: str(input?.["command"]) ?? title ?? toolName ?? "shell",
        ...(output === undefined ? {} : { output }),
        ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
        ...(status === "failed" ? { outputIndicatesFailure: true } : {}),
      };
    }
    case "file_edit":
    case "file_write": {
      const fileName = str(input?.["filePath"]);
      if (fileName === undefined) break;
      const changes = Array.isArray(input?.["changes"]) ? input["changes"].map(asRecord) : [];
      const oldStr =
        text(input?.["oldString"]) ??
        (changes.length > 0
          ? changes.map((c) => text(c?.["oldString"]) ?? "").join("\n")
          : undefined);
      const newStr =
        text(input?.["newString"]) ??
        text(input?.["content"]) ??
        (changes.length > 0
          ? changes.map((c) => text(c?.["newString"]) ?? "").join("\n")
          : undefined);
      return {
        ...common,
        type: "file_change",
        fileName,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
      };
    }
    case "file_search": {
      const pattern = str(input?.["pattern"]);
      const root = str(input?.["path"]) ?? pattern;
      return {
        ...common,
        type: "file_search",
        ...(pattern === undefined ? {} : { pattern }),
        ...(!output?.trim() || root === undefined
          ? {}
          : { results: [{ fileName: root, preview: output.slice(0, SEARCH_PREVIEW_MAX_CHARS) }] }),
      };
    }
    case "web_search": {
      const query = str(input?.["query"]);
      return {
        ...common,
        type: "web_search",
        ...(query === undefined ? {} : { patterns: [query] }),
        ...(!output?.trim()
          ? {}
          : { results: [{ snippet: output.slice(0, SEARCH_PREVIEW_MAX_CHARS) }] }),
      };
    }
  }
  return {
    ...common,
    type: "dynamic_tool",
    toolName,
    input: detail?.["input"] ?? null,
    ...(output === undefined ? {} : { output }),
  };
}
