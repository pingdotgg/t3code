// Extracted from server/adapter.ts.

import {
  type OrchestrationV2WebSearchResult,
  type ProviderRequestKind,
  type OrchestrationV2ExecutionNode,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { structuredPatch, formatPatch, FILE_HEADERS_ONLY } from "diff";
import { type AcpToolCallState } from "./runtimeModel.ts";
import { type ActiveAcpTurn } from "./acpTurnModel.ts";
import { unknownRecord } from "./clientPolicy.ts";
import * as DateTime from "effect/DateTime";
import * as EffectAcpSchema from "effect-acp/compat";

export function acpMcpToolCallOutput(rawOutput: unknown): unknown {
  const record = unknownRecord(rawOutput);
  if (record === undefined) return rawOutput;
  if (!("result" in record) && !("error" in record)) return rawOutput;
  const result = unknownRecord(record.result);
  const resultOutput =
    result === undefined ? undefined : (result.structuredContent ?? result.content ?? undefined);
  const errorMessage = unknownRecord(record.error)?.message;
  if (typeof errorMessage !== "string") {
    return resultOutput ?? rawOutput;
  }
  return resultOutput === undefined
    ? { error: errorMessage }
    : { error: errorMessage, result: resultOutput };
}

export function nonEmptyText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function decodeByteText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry) => typeof entry === "number" && Number.isInteger(entry))) {
    return undefined;
  }
  try {
    const text = new TextDecoder().decode(Uint8Array.from(value as number[]));
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const fromBytes = decodeByteText(value);
  if (fromBytes !== undefined) {
    return fromBytes;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      const text = textFromUnknown(entry);
      return text === undefined || text.length === 0 ? [] : [text];
    });
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  const record = unknownRecord(value);
  if (record === undefined) {
    return undefined;
  }
  for (const key of [
    "output_for_prompt",
    "stdout",
    "stderr",
    "output",
    "combinedOutput",
    "combined_output",
    "content",
    "text",
    "message",
  ]) {
    const direct = record[key];
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
    const decoded = decodeByteText(direct);
    if (decoded !== undefined) {
      return decoded;
    }
    const text = textFromUnknown(direct);
    if (text !== undefined && text.length > 0) {
      return text;
    }
  }
  const result = unknownRecord(record.Result) ?? unknownRecord(record.result);
  if (result !== undefined) {
    return textFromUnknown(result);
  }
  return undefined;
}

export function commandExitCode(value: unknown): number | undefined {
  const record = unknownRecord(value);
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = record?.[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function acpProjectedCommandExitCode(
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "interrupted",
  rawOutput: unknown,
): number | undefined {
  if (status !== "completed" && status !== "failed") {
    return undefined;
  }
  return commandExitCode(rawOutput);
}

export function structuredFileChanges(toolCall: AcpToolCallState) {
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    const diff = unknownRecord(entry);
    if (diff?.type !== "diff" || !Array.isArray(diff.changes)) return [];
    return diff.changes.flatMap((candidate) => {
      const change = unknownRecord(candidate);
      const operation = typeof change?.operation === "string" ? change.operation.trim() : "";
      const path = typeof change?.path === "string" ? change.path.trim() : "";
      if (operation.length === 0 || path.length === 0) return [];
      const oldPath = typeof change?.oldPath === "string" ? change.oldPath.trim() : "";
      const fileType = typeof change?.fileType === "string" ? change.fileType.trim() : "";
      const mimeType = typeof change?.mimeType === "string" ? change.mimeType.trim() : "";
      return [
        {
          operation,
          path,
          ...(oldPath.length === 0 ? {} : { oldPath }),
          ...(fileType.length === 0 ? {} : { fileType }),
          ...(mimeType.length === 0 ? {} : { mimeType }),
        },
      ];
    });
  });
}

export const ACP_V1_DIFF_MAX_EDITS = 1_000;

export function acpToolCallSnippetEdit(content: unknown) {
  if (!Array.isArray(content)) return undefined;
  const diffs = content.flatMap((entry) => {
    const diff = unknownRecord(entry);
    return diff?.type === "diff" ? [diff] : [];
  });
  const diff = diffs.length === 1 ? diffs[0] : undefined;
  if (diff === undefined || unknownRecord(diff.patch)?.format !== "snippet") return undefined;
  return typeof diff.oldText === "string" && typeof diff.newText === "string"
    ? { oldStr: diff.oldText, newStr: diff.newText }
    : undefined;
}

export function acpToolCallDiffUnpreviewable(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((entry) => {
      const format = unknownRecord(unknownRecord(entry)?.patch)?.format;
      return format === "omitted" || format === "snippet";
    })
  );
}

export function acpToolCallDiffPatch(content: unknown): string | undefined {
  if (!Array.isArray(content) || acpToolCallDiffUnpreviewable(content)) {
    return undefined;
  }
  const diffs = content.flatMap((entry) => {
    const diff = unknownRecord(entry);
    return diff?.type === "diff" ? [diff] : [];
  });
  const patches = diffs.flatMap((diff): ReadonlyArray<{ text: string; path?: string }> => {
    const patch = unknownRecord(diff.patch);
    if (typeof patch?.text === "string") {
      const change =
        Array.isArray(diff.changes) && diff.changes.length === 1
          ? unknownRecord(diff.changes[0])
          : undefined;
      if (
        patch.format === "git_patch" &&
        patch.text.trimStart().startsWith("@@ ") &&
        typeof change?.path === "string"
      ) {
        const oldPath = typeof change.oldPath === "string" ? change.oldPath : change.path;
        const before = change.operation === "add" ? "/dev/null" : JSON.stringify(`a/${oldPath}`);
        const after =
          change.operation === "delete" ? "/dev/null" : JSON.stringify(`b/${change.path}`);
        return [
          {
            text: `diff --git ${JSON.stringify(`a/${oldPath}`)} ${JSON.stringify(`b/${change.path}`)}\n--- ${before}\n+++ ${after}\n${patch.text.trimStart()}`,
          },
        ];
      }
      return [{ text: patch.text }];
    }
    if (typeof diff.path !== "string" || typeof diff.newText !== "string") return [];
    const oldText = typeof diff.oldText === "string" ? diff.oldText : undefined;
    const structured = structuredPatch(
      oldText === undefined ? "/dev/null" : diff.path,
      diff.path,
      oldText ?? "",
      diff.newText,
      undefined,
      undefined,
      {
        context: 3,
        maxEditLength: oldText && diff.newText ? ACP_V1_DIFF_MAX_EDITS : Number.POSITIVE_INFINITY,
      },
    );
    return structured === undefined || structured.hunks.length === 0
      ? []
      : [{ text: formatPatch(structured, FILE_HEADERS_ONLY), path: diff.path }];
  });
  // Diff parsers split at Git headers once one exists, so every section then needs its own.
  const hasGitHeader = patches.some(({ text }) => /^diff --git /m.test(text));
  return patches.length === 0
    ? undefined
    : patches
        .map(({ text, path }) =>
          hasGitHeader && path !== undefined
            ? `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n${text}`
            : text,
        )
        .join("\n");
}

export function pathFromToolCall(toolCall: AcpToolCallState): string | undefined {
  const locations = toolCall.data.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = unknownRecord(location)?.path;
      if (typeof path === "string" && path.trim().length > 0) {
        return path.trim();
      }
    }
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  for (const key of ["path", "filePath", "file_path", "url", "query", "pattern"]) {
    const candidate = rawInput?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function acpBackendWebSearch(
  rawInput: Record<string, unknown> | undefined,
  rawOutput: Record<string, unknown> | undefined,
):
  | { readonly query: string | undefined; readonly results: OrchestrationV2WebSearchResult[] }
  | undefined {
  const variant = typeof rawInput?.variant === "string" ? rawInput.variant.toLowerCase() : "";
  const action = unknownRecord(rawOutput?.action);
  if (variant !== "xsearch" && variant !== "websearch" && action?.type !== "search") {
    return undefined;
  }
  let args: Record<string, unknown> | undefined;
  if (typeof rawOutput?.input === "string") {
    try {
      args = unknownRecord(JSON.parse(rawOutput.input));
    } catch {
      args = undefined;
    }
  }
  const argsText = Object.entries(args ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  const query = [action?.query, args?.query, argsText]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const urls = new Set<string>();
  for (const source of Array.isArray(action?.sources) ? action.sources : []) {
    const url = unknownRecord(source)?.url;
    if (typeof url === "string" && url.trim().length > 0) urls.add(url.trim());
  }
  return { query, results: [...urls].map((url) => ({ url })) };
}

export function providerRequestKind(kind: string | "unknown"): ProviderRequestKind {
  switch (kind) {
    case "execute":
      return "command";
    case "read":
    case "search":
    case "fetch":
      return "file-read";
    case "edit":
    case "delete":
    case "move":
      return "file-change";
    default:
      return "command";
  }
}

export function toolStatus(
  status: AcpToolCallState["status"],
): "pending" | "running" | "waiting" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    case "requiresAction":
      return "waiting";
    default:
      return "running";
  }
}

export type ProjectedToolStatus = ReturnType<typeof toolStatus> | "interrupted";

export function stoppedToolStatus(
  turn: Pick<ActiveAcpTurn, "interrupted">,
  tool: AcpToolCallState,
): "interrupted" | undefined {
  return turn.interrupted && tool.status === "failed" ? "interrupted" : undefined;
}

export function nodeStatus(status: ProjectedToolStatus): OrchestrationV2ExecutionNode["status"] {
  return status === "pending" ? "running" : status;
}

export function completedAtForStatus(status: ProjectedToolStatus, now: DateTime.Utc): DateTime.Utc | null {
  return status === "completed" || status === "failed" || status === "interrupted" ? now : null;
}

export function isAcpPlanModeId(id: string): boolean {
  const name = id.slice(id.lastIndexOf("#") + 1);
  return name === "plan" || name === "architect";
}

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const optionIdOfKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
  if (decision === "acceptForSession") {
    // Agents may offer only allow_once, and answering "cancelled" would stop the turn the user approved.
    return optionIdOfKind("allow_always") ?? optionIdOfKind("allow_once");
  }
  return optionIdOfKind(decision === "accept" ? "allow_once" : "reject_once");
}

export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "accept") ??
    selectPermissionOptionId(request, "acceptForSession")
  );
}

export function elicitationContent(
  answers: ProviderUserInputAnswers,
  allowedKeys: ReadonlySet<string>,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      content[key] = value;
    } else if (Array.isArray(value)) {
      content[key] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return content;
}
