import type { OrchestrationSessionStatus, RuntimeMode, ServerProvider } from "@t3tools/contracts";

export interface CodexRuntimeStatus {
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly writableRoots: "none" | "workspace" | "all paths";
}

/**
 * T3's runtime modes are the persisted representation of the Codex thread
 * settings. Keep this mapping next to the status surface so the values shown
 * here stay aligned with the arguments sent to Codex App Server.
 */
export function describeCodexRuntimeMode(runtimeMode: RuntimeMode): CodexRuntimeStatus {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        writableRoots: "none",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        writableRoots: "workspace",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        writableRoots: "workspace",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        writableRoots: "all paths",
      };
  }
}

export function codexPermissionsLabel(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "approval-required":
      return "Read Only";
    case "auto-accept-edits":
      return "Workspace Write";
    case "auto":
      return "Auto";
    case "full-access":
    default:
      return "Full Access";
  }
}

export function codexRateLimitWindowLabel(windowDurationMins: number | null | undefined): string {
  if (windowDurationMins == null) return "Rate limit";
  if (windowDurationMins >= 10_000) return "Weekly limit";
  if (windowDurationMins >= 1_000) return "Daily limit";
  if (windowDurationMins >= 60) return `${Math.round(windowDurationMins / 60)}h limit`;
  return `${windowDurationMins}m limit`;
}

export function codexRemainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function isCodexSessionStatus(status: OrchestrationSessionStatus): boolean {
  return status !== "stopped" && status !== "idle";
}

export function codexProviderStatusLabel(provider: ServerProvider): string {
  if (!provider.enabled) return "Disabled";
  if (!provider.installed) return "Not installed";
  if (provider.auth.status === "unauthenticated") return "Not authenticated";
  if (provider.status === "error") return "Unavailable";
  if (provider.status === "warning") return "Needs attention";
  if (provider.status === "ready") return "Ready";
  return "Checking";
}

export function formatStatusTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const BRASILIA_TIME_ZONES = new Set([
  "America/Araguaina",
  "America/Bahia",
  "America/Belem",
  "America/Fortaleza",
  "America/Maceio",
  "America/Recife",
  "America/Sao_Paulo",
  "America/Santarem",
]);

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${hours}${minutes === 0 ? "" : `:${minutes.toString().padStart(2, "0")}`}`;
}

function formatStatusTimeZone(date: Date): string {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = formatUtcOffset(date);
  if (BRASILIA_TIME_ZONES.has(timeZone) && offset === "-3") return "BRT-3";

  const zoneName = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  if (!zoneName) return `UTC${offset}`;
  if (/^[A-Za-z]{2,6}$/.test(zoneName)) return `${zoneName}${offset}`;
  return zoneName;
}

export function formatStatusTimestampWithTimeZone(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${formatStatusTimestamp(value)} (${formatStatusTimeZone(date)})`;
}

function formatClaudeClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  const minute = parts.minute === "00" ? "" : `:${parts.minute}`;
  return `${parts.hour ?? ""}${minute}${(parts.dayPeriod ?? "").toLowerCase()}`;
}

/** Format Claude Code's compact reset labels using the browser's local zone. */
export function formatClaudeResetTimestamp(value: string, alwaysShowDate = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const clock = formatClaudeClock(date, timeZone);
  const hoursUntilReset = (date.getTime() - Date.now()) / (60 * 60 * 1000);
  const label =
    alwaysShowDate || hoursUntilReset > 24
      ? `${new Intl.DateTimeFormat("en-US", {
          timeZone,
          month: "short",
          day: "numeric",
        }).format(date)}, ${clock}`
      : clock;

  return `${label} (${timeZone})`;
}
