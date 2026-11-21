import type { PrinterJobStatus } from "@t3tools/contracts";

export function formatDurationCompact(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "--";
  }
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatClockTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(parsed));
}

export function formatAgeLabel(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.max(0, Math.round((nowMs - parsed) / 1000));
  if (seconds < 3) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function formatTemp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${Math.round(value)}°C`;
}

export function statusBadgeVariant(
  status: PrinterJobStatus,
  hasError: boolean,
): "success" | "warning" | "error" | "info" | "secondary" {
  if (hasError || status === "failed") return "error";
  switch (status) {
    case "running":
      return "success";
    case "prepare":
      return "info";
    case "pause":
      return "warning";
    case "finish":
      return "info";
    default:
      return "secondary";
  }
}

export function statusDotClass(
  status: PrinterJobStatus,
  online: boolean,
  hasError: boolean,
): string {
  if (hasError || status === "failed") return "bg-destructive";
  if (!online || status === "offline") return "bg-muted-foreground/50";
  switch (status) {
    case "running":
      return "bg-success";
    case "prepare":
      return "bg-info";
    case "pause":
      return "bg-warning";
    default:
      return "bg-muted-foreground/40";
  }
}

export function isActiveJobStatus(status: PrinterJobStatus): boolean {
  return status === "running" || status === "prepare" || status === "pause";
}
