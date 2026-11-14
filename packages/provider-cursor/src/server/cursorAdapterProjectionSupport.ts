// @effect-diagnostics nodeBuiltinImport:off
import type { ToolCall } from "@cursor/sdk";
import { type OrchestrationV2PlanStep } from "@t3tools/contracts";
import * as Path from "effect/Path";

export function cursorToolFileName(toolCall: ToolCall): string {
  switch (toolCall.type) {
    case "write":
    case "delete":
    case "read":
    case "edit":
    case "ls":
      return toolCall.args.path;
    case "generateImage":
      return toolCall.args.filePath ?? "generated-image";
    default:
      return cursorToolName(toolCall);
  }
}

export function cursorToolOutputText(toolCall: ToolCall): string {
  if (toolCall.type === "shell" && toolCall.result?.status === "success") {
    return [toolCall.result.value.stdout, toolCall.result.value.stderr]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (toolCall.type === "mcp" && toolCall.result?.status === "success") {
    return toolCall.result.value.content
      .flatMap((part) => (part.text === undefined ? [] : [part.text.text]))
      .join("\n");
  }
  const output = cursorToolOutput(toolCall);
  if (output === undefined) {
    return "";
  }
  return typeof output === "string" ? output : stableJson(output);
}

export function cursorToolFailed(toolCall: ToolCall): boolean {
  if (toolCall.result?.status === "error") {
    return true;
  }
  return toolCall.type === "mcp" && toolCall.result?.status === "success"
    ? toolCall.result.value.isError
    : false;
}
export const CURSOR_RESUME_NO_PROGRESS_MESSAGE =
  "Agent turn stopped after repeated resume attempts made no progress";

export function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function cursorToolOutput(toolCall: ToolCall): unknown {
  const result = toolCall.result;
  if (result === undefined) {
    return undefined;
  }
  return result.status === "success" ? result.value : result.error;
}

export function cursorToolName(toolCall: ToolCall): string {
  if (toolCall.type !== "mcp") {
    return toolCall.type;
  }
  const provider = toolCall.args.providerIdentifier ?? "mcp";
  const tool = toolCall.args.toolName ?? "unknown";
  return `mcp__${provider}__${tool}`;
}

export function cursorToolSearchPattern(toolCall: ToolCall): string | undefined {
  switch (toolCall.type) {
    case "glob":
      return toolCall.args.globPattern;
    case "grep":
      return toolCall.args.pattern;
    case "semSearch":
      return toolCall.args.query;
    case "ls":
      return toolCall.args.path;
    case "readLints":
      return toolCall.args.paths.join(", ");
    default:
      return undefined;
  }
}

export function cursorToolSearchResults(
  toolCall: ToolCall,
  path: Path.Path,
): ReadonlyArray<{
  readonly fileName: string;
  readonly line?: number;
  readonly column?: number;
  readonly preview?: string;
}> {
  if (toolCall.result?.status !== "success") {
    return [];
  }
  switch (toolCall.type) {
    case "glob":
      return toolCall.result.value.files.map((fileName) => ({ fileName }));
    case "grep":
      return Object.values(toolCall.result.value.workspaceResults ?? {}).flatMap((result) => {
        if (result.type === "files") {
          return result.output.files.map((fileName) => ({ fileName }));
        }
        if (result.type === "count") {
          return result.output.counts.map((entry) => ({
            fileName: entry.file,
            preview: `${entry.count} ${entry.count === 1 ? "match" : "matches"}`,
          }));
        }
        return result.output.matches.map((entry) => ({
          fileName: entry.file,
          ...(entry.lineNumber === undefined ? {} : { line: entry.lineNumber }),
          preview: entry.line,
        }));
      });
    case "ls":
      return cursorLsSearchResults(toolCall.result.value.directoryTreeRoot, path);
    case "readLints":
      return toolCall.result.value.fileDiagnostics.flatMap((file) =>
        file.diagnostics.map((diagnostic) => {
          const line = diagnostic.range?.start?.line;
          const character = diagnostic.range?.start?.character;
          const hasLine = typeof line === "number" && Number.isInteger(line) && line >= 0;
          return {
            fileName: file.path,
            ...(hasLine ? { line: line + 1 } : {}),
            ...(hasLine &&
            typeof character === "number" &&
            Number.isInteger(character) &&
            character >= 0
              ? { column: character + 1 }
              : {}),
            preview: diagnostic.message,
          };
        }),
      );
    case "semSearch":
      return [
        {
          fileName: "semantic-search",
          preview: toolCall.result.value.results,
        },
      ];
    default:
      return [];
  }
}

export function cursorTodoSteps(
  toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>,
): ReadonlyArray<OrchestrationV2PlanStep> {
  const todos =
    toolCall.result?.status === "success" ? toolCall.result.value.todos : toolCall.args.todos;
  return todos
    .filter((todo) => todo.status !== "cancelled" && todo.content.trim().length > 0)
    .map((todo, index) => ({
      id: `todo-${index + 1}`,
      text: todo.content,
      status:
        todo.status === "inProgress"
          ? "running"
          : todo.status === "completed"
            ? "completed"
            : "pending",
    }));
}

export function assistantTextsFromConversationSteps(
  steps: ReadonlyArray<unknown>,
): ReadonlyArray<string> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "assistantMessage") {
      const text = nestedString(record, ["message", "text"]);
      return text === undefined || text.length === 0 ? [] : [text];
    }
    const text = nestedString(record, ["assistantMessage", "text"]);
    return text === undefined || text.length === 0 ? [] : [text];
  });
}

export function toolCallsFromConversationSteps(
  steps: ReadonlyArray<unknown>,
): ReadonlyArray<{ readonly callId: string; readonly toolCall: ToolCall }> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "toolCall") {
      const message = unknownRecord(record.message);
      return typeof message?.type === "string"
        ? [
            {
              callId: typeof record.callId === "string" ? record.callId : `nested-${message.type}`,
              toolCall: message as ToolCall,
            },
          ]
        : [];
    }
    const envelope = unknownRecord(record?.toolCall);
    const nested = envelope === undefined ? undefined : nestedToolCallFromEnvelope(envelope);
    return nested === undefined ? [] : [nested];
  });
}

export const MAX_CURSOR_STREAMED_OUTPUT_CHARS = 256 * 1024;
// After a turn ends, a retryable stream error can make Cursor's SDK resume from
// an older checkpoint inside the same run. When those resumes save nothing, it
// ends the run with this error even though the answer was already delivered.

export function cursorLsSearchResults(
  node: CursorLsDirectoryNode,
  path: Path.Path,
): ReadonlyArray<{ readonly fileName: string }> {
  return [
    ...node.childrenFiles.map((file) => ({ fileName: path.join(node.absPath, file.name) })),
    ...node.childrenDirs.flatMap((child) => cursorLsSearchResults(child, path)),
  ];
}

export function nestedString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    current = unknownRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

export function nestedToolCallFromEnvelope(
  envelope: Record<string, unknown>,
): { readonly callId: string; readonly toolCall: ToolCall } | undefined {
  const callId = typeof envelope.toolCallId === "string" ? envelope.toolCallId : undefined;
  const wrapperEntry = Object.entries(envelope).find(([key]) => key.endsWith("ToolCall"));
  if (wrapperEntry === undefined) {
    return undefined;
  }
  const [wrapperName, rawCall] = wrapperEntry;
  const call = unknownRecord(rawCall);
  if (call === undefined) {
    return undefined;
  }
  const args = unknownRecord(call.args) ?? {};
  const fallbackCallId = `nested-${wrapperName}`;
  const nestedCallId = callId ?? fallbackCallId;

  switch (wrapperName) {
    case "readToolCall": {
      const success = unknownRecord(unknownRecord(call.result)?.success);
      const path =
        typeof args.path === "string"
          ? args.path
          : typeof success?.path === "string"
            ? success.path
            : "<unknown path>";
      return {
        callId: nestedCallId,
        toolCall: {
          type: "read",
          args: { path },
          result: nestedToolResult(call.result, (value) => ({
            content: typeof value.content === "string" ? value.content : "",
            totalLines: typeof value.totalLines === "number" ? value.totalLines : 0,
            fileSize: typeof value.fileSize === "number" ? value.fileSize : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    case "globToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "glob",
          args: {
            globPattern: typeof args.globPattern === "string" ? args.globPattern : "**/*",
            ...(typeof args.targetDirectory === "string"
              ? { targetDirectory: args.targetDirectory }
              : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            files: Array.isArray(value.files)
              ? value.files.filter((file): file is string => typeof file === "string")
              : [],
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            clientTruncated: false,
            ripgrepTruncated: false,
          })),
        } as unknown as ToolCall,
      };
    case "grepToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "grep",
          args: {
            pattern: typeof args.pattern === "string" ? args.pattern : "",
            ...(typeof args.path === "string" ? { path: args.path } : {}),
            ...(typeof args.glob === "string" ? { glob: args.glob } : {}),
            ...(typeof args.outputMode === "string" ? { outputMode: args.outputMode } : {}),
            ...(typeof args.caseInsensitive === "boolean"
              ? { caseInsensitive: args.caseInsensitive }
              : {}),
            ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
            ...(typeof args.multiline === "boolean" ? { multiline: args.multiline } : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            workspaceResults: nestedGrepWorkspaceResults(value),
          })),
        } as unknown as ToolCall,
      };
    case "shellToolCall": {
      const rawResult = unknownRecord(call.result);
      const permissionDenied = unknownRecord(rawResult?.permissionDenied);
      const command =
        typeof args.command === "string"
          ? args.command
          : typeof permissionDenied?.command === "string"
            ? permissionDenied.command
            : "<unknown command>";
      return {
        callId: nestedCallId,
        toolCall: {
          type: "shell",
          args: { command },
          result: nestedToolResult(call.result, (value) => ({
            stdout: typeof value.stdout === "string" ? value.stdout : "",
            stderr: typeof value.stderr === "string" ? value.stderr : "",
            exitCode: typeof value.exitCode === "number" ? value.exitCode : 0,
            signal: typeof value.signal === "string" ? value.signal : "",
            executionTime: typeof value.executionTime === "number" ? value.executionTime : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    case "lsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "ls",
          args: { path: typeof args.path === "string" ? args.path : "" },
          result: nestedToolResult(call.result, (value) => ({
            directoryTreeRoot: nestedLsDirectory(value.directoryTreeRoot),
          })),
        } as unknown as ToolCall,
      };
    case "readLintsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "readLints",
          args: {
            paths: nestedArray(args.paths).filter(
              (path): path is string => typeof path === "string",
            ),
          },
          result: nestedToolResult(call.result, (value) => ({
            fileDiagnostics: nestedArray(value.fileDiagnostics).map((rawFile) => {
              const file = unknownRecord(rawFile);
              return {
                path: typeof file?.path === "string" ? file.path : "",
                diagnostics: nestedArray(file?.diagnostics).flatMap((rawDiagnostic) => {
                  const diagnostic = unknownRecord(rawDiagnostic);
                  return diagnostic === undefined
                    ? []
                    : [
                        {
                          ...diagnostic,
                          message: typeof diagnostic.message === "string" ? diagnostic.message : "",
                        },
                      ];
                }),
              };
            }),
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            totalDiagnostics:
              typeof value.totalDiagnostics === "number" ? value.totalDiagnostics : 0,
          })),
        } as unknown as ToolCall,
      };
    case "mcpToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "mcp",
          args,
          result: nestedToolResult(call.result, (value) => ({
            content: nestedArray(value.content).flatMap((rawPart) => {
              const part = unknownRecord(rawPart);
              return part === undefined ? [] : [part];
            }),
            isError: value.isError === true,
          })),
        } as unknown as ToolCall,
      };
    default: {
      const type = wrapperName.slice(0, -"ToolCall".length);
      return {
        callId: nestedCallId,
        toolCall: {
          type,
          args,
          result: nestedToolResult(call.result),
        } as unknown as ToolCall,
      };
    }
  }
}

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type CursorLsDirectoryNode = Extract<
  Extract<ToolCall, { readonly type: "ls" }>["result"],
  { readonly status: "success" }
>["value"]["directoryTreeRoot"];

export function nestedArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

export function nestedGrepWorkspaceResults(
  success: Record<string, unknown>,
): Record<string, unknown> {
  const workspaces = unknownRecord(success.workspaceResults);
  if (workspaces === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(workspaces).map(([workspace, rawWorkspaceResult]) => {
      const workspaceResult = unknownRecord(rawWorkspaceResult);
      const content = unknownRecord(workspaceResult?.content);
      const rawMatches = Array.isArray(content?.matches) ? content.matches : [];
      const matches = rawMatches.flatMap((rawFileMatch) => {
        const fileMatch = unknownRecord(rawFileMatch);
        const file = typeof fileMatch?.file === "string" ? fileMatch.file : "";
        const lineMatches = Array.isArray(fileMatch?.matches) ? fileMatch.matches : [];
        return lineMatches.flatMap((rawLineMatch) => {
          const lineMatch = unknownRecord(rawLineMatch);
          if (lineMatch === undefined) {
            return [];
          }
          const line = typeof lineMatch.content === "string" ? lineMatch.content : undefined;
          if (file.length === 0 || line === undefined) {
            return [];
          }
          return [
            {
              file,
              line,
              ...(typeof lineMatch.lineNumber === "number"
                ? { lineNumber: lineMatch.lineNumber }
                : {}),
            },
          ];
        });
      });
      return [
        workspace,
        {
          type: "content",
          output: {
            matches,
            totalMatches:
              typeof content?.totalMatchedLines === "number"
                ? content.totalMatchedLines
                : matches.length,
          },
        },
      ];
    }),
  );
}

export function nestedLsDirectory(rawNode: unknown): CursorLsDirectoryNode {
  const node = unknownRecord(rawNode);
  return {
    absPath: typeof node?.absPath === "string" ? node.absPath : "",
    childrenDirs: nestedArray(node?.childrenDirs).map(nestedLsDirectory),
    childrenFiles: nestedArray(node?.childrenFiles).flatMap((rawFile) => {
      const name = unknownRecord(rawFile)?.name;
      return typeof name === "string" ? [{ name }] : [];
    }),
    childrenWereProcessed: node?.childrenWereProcessed === true,
    fullSubtreeExtensionCounts: Object.fromEntries(
      Object.entries(unknownRecord(node?.fullSubtreeExtensionCounts) ?? {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    ),
    numFiles: typeof node?.numFiles === "number" ? node.numFiles : 0,
  };
}

export function nestedToolResult<Value = Record<string, unknown>>(
  rawResult: unknown,
  mapSuccess: (success: Record<string, unknown>) => Value = (success) => success as Value,
):
  | { readonly status: "success"; readonly value: Value }
  | { readonly status: "error"; readonly error: unknown }
  | undefined {
  const result = unknownRecord(rawResult);
  if (result === undefined) {
    return undefined;
  }
  const success = unknownRecord(result.success);
  if (success !== undefined) {
    return {
      status: "success",
      value: mapSuccess(success),
    };
  }
  return {
    status: "error",
    error: result.error ?? result.permissionDenied ?? result,
  };
}
