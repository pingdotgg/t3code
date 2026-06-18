import type { ToolLifecycleItemType } from "@t3tools/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toolArgumentsLookLikeFileChange(arguments_: unknown): boolean {
  if (!isRecord(arguments_)) {
    return false;
  }

  const filePathKeys = [
    "path",
    "filePath",
    "file_path",
    "file",
    "fileName",
    "filename",
    "targetFile",
    "target_file",
  ];
  const editPayloadKeys = [
    "content",
    "newContent",
    "new_content",
    "oldString",
    "old_string",
    "newString",
    "new_string",
    "diff",
    "patch",
    "edits",
  ];

  const hasFilePath = filePathKeys.some((key) => trimmedString(arguments_[key]) !== undefined);
  const hasEditPayload = editPayloadKeys.some((key) => arguments_[key] !== undefined);
  return hasFilePath && hasEditPayload;
}

function commandLooksLikeFileChange(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return /(?:^|\s)apply_patch(?:\s|$)/u.test(command) || command.includes("*** Begin Patch");
}

function toolCommandLooksLikeFileChange(arguments_: unknown): boolean {
  if (!isRecord(arguments_)) {
    return false;
  }
  const candidates = [
    arguments_.command,
    arguments_.cmd,
    arguments_.fullCommandText,
    arguments_.commandText,
    isRecord(arguments_.input) ? arguments_.input.command : undefined,
  ];
  return candidates.some((candidate) => commandLooksLikeFileChange(trimmedString(candidate)));
}

export function isReadOnlyCopilotToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("read_file") ||
    normalized.includes("readfile") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function toolNameImpliesFileChange(toolName: string, arguments_: unknown): boolean {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("replace")
  ) {
    return true;
  }

  if (
    normalized.includes("create") ||
    normalized.includes("delete") ||
    normalized.includes("remove") ||
    normalized.includes("modify") ||
    normalized.includes("update") ||
    normalized.includes("insert")
  ) {
    return normalized.includes("file") || toolArgumentsLookLikeFileChange(arguments_);
  }

  return toolArgumentsLookLikeFileChange(arguments_);
}

export function classifyCopilotToolItemType(input: {
  readonly toolName: string;
  readonly mcpServerName?: string | undefined;
  readonly arguments?: unknown;
}): ToolLifecycleItemType {
  const normalized = input.toolName.toLowerCase();
  if (input.mcpServerName || normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent") ||
    normalized.includes("agent") ||
    normalized.includes("delegate") ||
    normalized.includes("task")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    toolNameImpliesFileChange(input.toolName, input.arguments) ||
    toolCommandLooksLikeFileChange(input.arguments)
  ) {
    return "file_change";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("exec") ||
    normalized.includes("command") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("websearch") ||
    normalized.includes("web search") ||
    normalized.includes("web_search") ||
    normalized.includes("web") ||
    normalized.includes("fetch")
  ) {
    return "web_search";
  }
  if (normalized.includes("image") || normalized.includes("screenshot")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}
