import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";

// Search results stay on the timeline wire, so keep their text a preview.
const SEARCH_PREVIEW_MAX_CHARS = 8_000;

type ToolItemBase = Omit<
  Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
  "type" | "toolName" | "input" | "output"
>;

export function openCodeToolProjectionKind(
  toolName: string,
): "command_execution" | "file_change" | "file_search" | "web_search" | "dynamic_tool" {
  if (resolveT3McpToolId(toolName) !== null) return "dynamic_tool";
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite") {
    return "dynamic_tool";
  }
  if (normalized.includes("bash") || normalized.includes("shell")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web") || normalized === "codesearch" || normalized === "code_search") {
    return "web_search";
  }
  if (normalized === "read") {
    return "dynamic_tool";
  }
  if (
    normalized.includes("glob") ||
    normalized.includes("grep") ||
    normalized.includes("search") ||
    normalized.includes("lsp")
  ) {
    return "file_search";
  }
  return "dynamic_tool";
}

function recordString(input: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function recordNumber(input: unknown, ...keys: ReadonlyArray<string>): number | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stableJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function nativeReadOutput(output: string): string {
  const header = /^<path>[^\r\n]+<\/path>\r?\n<type>(directory|file)<\/type>\r?\n/.exec(output);
  if (header === null) return output;
  const body = output.slice(header[0].length);
  // File lines are numbered; only a closing tag on its own line ends the envelope.
  const envelope =
    header[1] === "directory"
      ? /^<entries>\r?\n([\s\S]*?)\r?\n<\/entries>(?=\r?\n|$)/.exec(body)
      : /^<content>(?:\r?\n)?([\s\S]*?)\r?\n<\/content>(?=\r?\n|$)/.exec(body);
  // OpenCode can append instructions after the envelope; keep that suffix verbatim.
  return envelope === null ? output : envelope[1] + body.slice(envelope[0].length);
}

export function openCodeToolTurnItem(
  base: ToolItemBase,
  tool: {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly output: string | undefined;
    readonly completedMetadata: unknown;
  },
): OrchestrationV2TurnItem {
  const { input, output } = tool;
  switch (openCodeToolProjectionKind(tool.name)) {
    case "command_execution": {
      const exitCode = recordNumber(tool.completedMetadata, "exit", "exitCode");
      return {
        ...base,
        type: "command_execution",
        input: recordString(input, "command", "cmd") ?? stableJson(input),
        ...(output === undefined ? {} : { output }),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    case "file_change": {
      const oldStr = recordString(input, "oldString", "oldText");
      const newStr = recordString(input, "newString", "content", "newText");
      const diffStr =
        recordString(tool.completedMetadata, "diff", "patch") ??
        (base.status === "failed" && output?.trim() ? output : undefined);
      return {
        ...base,
        type: "file_change",
        fileName: recordString(input, "filePath", "path", "file") ?? tool.name,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(diffStr === undefined ? {} : { diffStr }),
      };
    }
    case "file_search": {
      const pattern = recordString(input, "pattern", "query", "path", "filePath");
      const searchRoot = (recordString(input, "path", "filePath") ?? pattern)?.trim();
      return {
        ...base,
        title:
          formatSearchToolLabel({ input, ...(pattern === undefined ? {} : { pattern }) }) ??
          base.title,
        type: "file_search",
        ...(pattern === undefined ? {} : { pattern }),
        ...(!output?.trim() || searchRoot === undefined
          ? {}
          : {
              results: [
                { fileName: searchRoot, preview: output.slice(0, SEARCH_PREVIEW_MAX_CHARS) },
              ],
            }),
      };
    }
    case "web_search": {
      const pattern = recordString(input, "query", "url", "pattern");
      const url = recordString(input, "url")?.trim();
      return {
        ...base,
        type: "web_search",
        ...(pattern === undefined ? {} : { patterns: [pattern] }),
        ...(!output?.trim()
          ? {}
          : {
              results: [
                {
                  ...(url === undefined ? {} : { url }),
                  snippet: output.slice(0, SEARCH_PREVIEW_MAX_CHARS),
                },
              ],
            }),
      };
    }
    case "dynamic_tool": {
      const readPath = recordString(input, "filePath", "path", "file");
      const cleanedOutput =
        tool.name === "read" && output !== undefined ? nativeReadOutput(output) : output;
      return {
        ...base,
        title:
          tool.name.toLowerCase() === "read" && readPath !== undefined
            ? formatReadToolLabel(readPath)
            : base.title,
        type: "dynamic_tool",
        toolName: tool.name,
        input,
        ...(cleanedOutput === undefined ? {} : { output: cleanedOutput }),
      };
    }
  }
}
