import type {
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2WebSearchResult,
} from "@t3tools/contracts";

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

function recordedEditPatch(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const lines = (value: string) => (value === "" ? [] : value.replace(/\r?\n$/, "").split(/\r?\n/));
  const hunks: string[] = [];
  for (const occurrence of value as unknown[]) {
    const entry = asRecord(occurrence);
    const { startLine, newStartLine = startLine, oldText, newText } = entry ?? {};
    if (
      typeof startLine !== "number" ||
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      typeof newStartLine !== "number" ||
      !Number.isSafeInteger(newStartLine) ||
      newStartLine < 1 ||
      typeof oldText !== "string" ||
      typeof newText !== "string"
    )
      return undefined;
    const before = lines(oldText);
    const after = lines(newText);
    hunks.push(
      [
        `@@ -${startLine},${before.length} +${newStartLine},${after.length} @@`,
        ...before.map((line) => `-${line}`),
        ...after.map((line) => `+${line}`),
      ].join("\n"),
    );
  }
  return hunks.join("\n") + "\n";
}

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
    const streaming = entry["generationStatus"] === "in_progress";
    return {
      ...base,
      status: streaming ? "running" : "completed",
      title: null,
      type: "reasoning",
      text: reasoning,
      streaming,
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
  const outputRecord = asRecord(state?.["output"]);
  const common = { ...base, status, title };

  switch (str(detail?.["kind"])) {
    case "shell": {
      const output = effectOutput(state);
      const exitCode = outputRecord?.["exitCode"];
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
      const occurrences = outputRecord?.["occurrences"];
      const diffStr = recordedEditPatch(occurrences);
      if (diffStr !== undefined) return { ...common, type: "file_change", fileName, diffStr };
      const singleOccurrence =
        Array.isArray(occurrences) && occurrences.length === 1
          ? asRecord(occurrences[0])
          : undefined;
      const changes = Array.isArray(input?.["changes"]) ? input["changes"].map(asRecord) : [];
      const oldStr =
        text(singleOccurrence?.["oldText"]) ??
        text(outputRecord?.["oldString"]) ??
        text(input?.["oldString"]) ??
        (detail?.["kind"] === "file_write" ? text(outputRecord?.["previousContent"]) : undefined) ??
        (changes.length > 0
          ? changes.map((c) => text(c?.["oldString"]) ?? "").join("\n")
          : undefined);
      const newStr =
        text(singleOccurrence?.["newText"]) ??
        text(outputRecord?.["newString"]) ??
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
      const matches = outputRecord?.["parsedMatches"];
      const results = Array.isArray(matches)
        ? matches.flatMap((match: unknown) => {
            const record = asRecord(match);
            const fileName = str(record?.["path"]);
            if (fileName === undefined) return [];
            const line = record?.["line"];
            return [
              {
                fileName,
                ...(typeof line === "number" && Number.isInteger(line) && line > 0 ? { line } : {}),
              },
            ];
          })
        : [];
      return {
        ...common,
        type: "file_search",
        ...(pattern === undefined ? {} : { pattern }),
        results,
      };
    }
    case "web_search": {
      const answer = str(outputRecord?.["answer"]);
      const sources = outputRecord?.["sources"];
      const results: OrchestrationV2WebSearchResult[] = [];
      if (answer !== undefined)
        results.push({ snippet: answer.slice(0, SEARCH_PREVIEW_MAX_CHARS) });
      if (Array.isArray(sources)) {
        for (const source of sources as unknown[]) {
          const record = asRecord(source);
          const url = str(record?.["url"]);
          const title = str(record?.["title"]);
          if (url !== undefined) results.push({ url, ...(title === undefined ? {} : { title }) });
        }
      }
      const query = str(input?.["query"]);
      return {
        ...common,
        type: "web_search",
        ...(query === undefined ? {} : { patterns: [query] }),
        ...(results.length === 0 ? {} : { results }),
      };
    }
  }
  const output = effectOutput(state);
  return {
    ...common,
    type: "dynamic_tool",
    toolName,
    input: detail?.["input"] ?? null,
    ...(output === undefined ? {} : { output }),
  };
}
