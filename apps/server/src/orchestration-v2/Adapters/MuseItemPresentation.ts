import type { OrchestrationV2TurnItem, OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { MuseItem } from "../../provider/museProtocol.ts";

const decodeToolArgs = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

type Fields<
  T extends OrchestrationV2TurnItem["type"],
  K extends keyof Extract<OrchestrationV2TurnItem, { type: T }>,
> = Pick<Extract<OrchestrationV2TurnItem, { type: T }>, K>;
type MuseToolPresentation = {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly title: string | null;
} & (
  | Fields<"command_execution", "type" | "input" | "output" | "exitCode">
  | Fields<"file_change", "type" | "fileName" | "oldStr" | "newStr" | "diffStr">
  | Fields<"web_search", "type" | "patterns" | "results">
  | Fields<"dynamic_tool", "type" | "toolName" | "input" | "output">
);

/** Unrecognized native terminal states must not appear as successful work. */
export function museItemStatus(item: MuseItem): OrchestrationV2TurnItemStatus {
  if (item.status === "inProgress") return "running";
  if (item.status === "cancelled") return "cancelled";
  if (
    item.status === "completed" &&
    !(item.kind === "compaction" && item.outcome && item.outcome !== "compacted")
  )
    return "completed";
  return "failed";
}

/** Converts native tool details into the shared timeline fields used by every client. */
export function museToolPresentation(
  item: MuseItem,
  status = museItemStatus(item),
): MuseToolPresentation {
  let args: Record<string, unknown> | undefined;
  if (item.args) {
    try {
      args = decodeToolArgs(item.args);
    } catch {
      // Streaming model-authored arguments may not be valid JSON yet.
    }
  }
  const stringArg = (...keys: string[]) => {
    for (const key of keys) {
      const value = args?.[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  };
  const toolName = item.tool ?? item.kind;
  const title =
    item.kind === "reminderChild"
      ? "Reminder"
      : item.kind === "subagent"
        ? item.objective || item.role || "Muse agent"
        : toolName;
  const detail =
    status === "failed" ? item.failureReason || `Muse reported ${item.status}.` : undefined;
  const shared = { status, title: detail ? `${title}: ${detail}` : title };
  const text =
    item.visibleOutput ??
    item.result?.summary ??
    item.text ??
    item.summary?.join("\n") ??
    item.fallbackText ??
    item.objective ??
    "";
  const output = detail ? [detail, text].filter(Boolean).join("\n") : text;

  if (item.kind === "userShell" || /shell|bash|exec_command/i.test(item.tool ?? "")) {
    return {
      ...shared,
      type: "command_execution",
      input: item.commandText ?? stringArg("command", "cmd") ?? item.args ?? "",
      output,
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    };
  }
  if (item.kind === "toolCall" && /write|edit|patch/i.test(toolName)) {
    const fileName = stringArg("file_path", "path", "filePath")?.trim();
    if (fileName) {
      const oldStr = stringArg("old_string", "old_str", "oldStr", "oldText");
      const newStr = stringArg("new_string", "new_str", "newStr", "newText", "content");
      const diffStr = stringArg("diff", "patch", "diffStr");
      return {
        ...shared,
        type: "file_change",
        fileName,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(diffStr === undefined ? {} : { diffStr }),
      };
    }
  }
  if (item.kind === "toolCall" && /web|browse|fetch/i.test(toolName)) {
    const query = stringArg("query", "url", "pattern")?.trim();
    return {
      ...shared,
      type: "web_search",
      ...(query ? { patterns: [query] } : {}),
      ...(output ? { results: [{ snippet: output }] } : {}),
    };
  }
  return {
    ...shared,
    type: "dynamic_tool",
    toolName,
    input: args ?? item.args ?? "",
    output,
  };
}
