import type {
  OrchestrationThreadActivity,
  ProviderKind,
  ProviderSession,
} from "@t3tools/contracts";

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

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<string, PendingApproval>();
  const ordered = [...activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );

  for (const activity of ordered) {
    if (activity.requestId && activity.requestKind) {
      openByRequestId.set(activity.requestId, {
        requestId: activity.requestId,
        requestKind: activity.requestKind,
        createdAt: activity.createdAt,
        ...(activity.detail ? { detail: activity.detail } : {}),
      });
      continue;
    }

    if (activity.requestId && activity.label === "Approval resolved") {
      openByRequestId.delete(activity.requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: string | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter((activity) => activity.label !== "Checkpoint captured")
    .map((activity) => {
      const entry: WorkLogEntry = {
        id: activity.id,
        createdAt: activity.createdAt,
        label: activity.label,
        tone: activity.tone,
      };
      if (activity.detail) {
        entry.detail = activity.detail;
      }
      return entry;
    });
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
  return [...messageRows, ...workRows].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deriveTurnDiffFilesFromUnifiedDiff(diff: string): TurnDiffFileChange[] {
  const normalized = diff.replace(/\r\n/g, "\n");
  const headerMatches = [...normalized.matchAll(/^diff --git .+$/gm)];
  if (headerMatches.length === 0) {
    return [];
  }

  const files: TurnDiffFileChange[] = [];
  for (let index = 0; index < headerMatches.length; index += 1) {
    const header = headerMatches[index];
    if (!header) continue;
    const start = header.index ?? 0;
    const nextStart = headerMatches[index + 1]?.index ?? normalized.length;
    const segment = normalized.slice(start, nextStart);
    const headerLine = header[0];
    if (!headerLine) continue;

    const match = headerLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const filePath = match?.[2] ?? match?.[1];
    if (!filePath) continue;

    let additions = 0;
    let deletions = 0;
    for (const line of segment.split("\n")) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("+")) {
        additions += 1;
        continue;
      }
      if (line.startsWith("-")) {
        deletions += 1;
      }
    }

    files.push({
      path: filePath,
      additions,
      deletions,
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<string, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<string, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function deriveTurnDiffSummaries(_events: ReadonlyArray<OrchestrationThreadActivity>): TurnDiffSummary[] {
  return [];
}

export function derivePhase(session: ProviderSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
