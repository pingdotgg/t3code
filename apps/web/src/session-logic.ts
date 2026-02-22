import type { ProviderKind, ProviderSession } from "@t3tools/contracts";

import type { ChatMessage, SessionPhase, TurnDiffFileChange, TurnDiffSummary } from "./types";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderKind;
  label: string;
  available: boolean;
}> = [
  { value: "codex", label: "Codex", available: true },
  { value: "claudeCode", label: "Claude Code (soon)", available: false },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  tone: "thinking" | "tool" | "info" | "error";
}

export interface PendingApproval {
  requestId: string;
  requestKind: "command" | "file-change";
  createdAt: string;
  detail?: string;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoDate));
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

export function derivePendingApprovals(_events: unknown[]): PendingApproval[] {
  return [];
}

export function deriveWorkLogEntries(
  _events: unknown[],
  _latestTurnId: string | undefined,
): WorkLogEntry[] {
  return [];
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...workRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deriveTurnDiffFilesFromUnifiedDiff(diff: string): TurnDiffFileChange[] {
  const files: TurnDiffFileChange[] = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const filePath = match?.[2] ?? match?.[1];
    if (!filePath) continue;
    files.push({ path: filePath });
  }
  return files;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<string, number> {
  const sorted = [...summaries].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<string, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function deriveTurnDiffSummaries(_events: unknown[]): TurnDiffSummary[] {
  return [];
}

export function derivePhase(session: ProviderSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
