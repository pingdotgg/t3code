import type { WorkLogEntry } from "../../session-logic";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedPlainString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function webSearchActionRecord(toolData: unknown): Record<string, unknown> | null {
  return asPlainRecord(asPlainRecord(toolData)?.action);
}

function webSearchQueries(toolData: unknown): string[] {
  const item = asPlainRecord(toolData);
  const action = webSearchActionRecord(toolData);
  if (Array.isArray(action?.queries)) {
    const queries: string[] = [];
    for (const query of action.queries) {
      const trimmed = asTrimmedPlainString(query);
      if (trimmed) {
        queries.push(trimmed);
      }
    }
    if (queries.length > 0) {
      return queries;
    }
  }

  const actionQuery = asTrimmedPlainString(action?.query);
  if (actionQuery) {
    return [actionQuery];
  }

  const itemQuery = asTrimmedPlainString(item?.query);
  if (itemQuery) {
    return [itemQuery];
  }
  return [];
}

function webSearchPreview(toolData: unknown): string | null {
  const action = webSearchActionRecord(toolData);
  const actionType = asTrimmedPlainString(action?.type);
  const queries = webSearchQueries(toolData);
  if (queries.length > 0) {
    const [firstQuery] = queries;
    if (!firstQuery) {
      return null;
    }
    return queries.length === 1 ? firstQuery : `${firstQuery} +${queries.length - 1} more`;
  }
  const url = asTrimmedPlainString(action?.url);
  const pattern = asTrimmedPlainString(action?.pattern);
  if ((actionType === "findInPage" || actionType === "find_in_page") && pattern && url) {
    return `${pattern} in ${url}`;
  }
  return pattern ?? url;
}

function formatWebSearchExpandedBody(toolData: unknown): string | null {
  try {
    return JSON.stringify(toolData, null, 2);
  } catch {
    return null;
  }
}

export function workEntryPreview(
  workEntry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles" | "itemType" | "toolData">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.itemType === "web_search") {
    const preview = webSearchPreview(workEntry.toolData);
    if (preview) return preview;
  }
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

export function buildToolCallExpandedBody(
  workEntry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  if (workEntry.itemType === "web_search" && workEntry.toolData !== undefined) {
    const body = formatWebSearchExpandedBody(workEntry.toolData);
    if (body) {
      blocks.push(body);
    }
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}
