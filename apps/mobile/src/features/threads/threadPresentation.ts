import type { OrchestrationThread, ServerConfig as T3ServerConfig } from "@t3tools/contracts";

import type { StatusTone } from "../../components/StatusPill";
import { reverseCopy } from "../../lib/arrayCompat";

export function threadSortValue(thread: OrchestrationThread): number {
  const candidate = Date.parse(thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(candidate) ? 0 : candidate;
}

export function threadStatusTone(thread: OrchestrationThread): StatusTone {
  const status = thread.session?.status;
  if (status === "running") {
    return {
      label: "Running",
      pillClassName: "bg-orange-500/12 dark:bg-orange-500/16",
      textClassName: "text-orange-700 dark:text-orange-300",
    };
  }
  if (status === "ready") {
    return {
      label: "Ready",
      pillClassName: "bg-emerald-500/12 dark:bg-emerald-500/16",
      textClassName: "text-emerald-700 dark:text-emerald-300",
    };
  }
  if (status === "starting") {
    return {
      label: "Starting",
      pillClassName: "bg-sky-500/12 dark:bg-sky-500/16",
      textClassName: "text-sky-700 dark:text-sky-300",
    };
  }
  if (status === "error") {
    return {
      label: "Error",
      pillClassName: "bg-rose-500/12 dark:bg-rose-500/16",
      textClassName: "text-rose-700 dark:text-rose-300",
    };
  }
  return {
    label: "Idle",
    pillClassName: "bg-slate-500/10 dark:bg-slate-500/16",
    textClassName: "text-slate-600 dark:text-slate-300",
  };
}

export function messageImageUrl(
  httpOrigin: string | null,
  attachmentId: string,
  authToken: string | null,
): string | null {
  if (!httpOrigin) {
    return null;
  }

  const url = new URL(`/attachments/${encodeURIComponent(attachmentId)}`, httpOrigin);
  if (authToken) {
    url.searchParams.set("token", authToken);
  }
  return url.toString();
}

export function lastConversationLine(thread: OrchestrationThread): string {
  const candidate = reverseCopy(thread.messages).find(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (!candidate) {
    return "No messages yet.";
  }

  const trimmed = candidate.text.trim();
  if (trimmed.length === 0) {
    return candidate.role === "assistant" ? "(empty assistant response)" : "(empty message)";
  }
  return trimmed;
}

export function screenTitle(config: T3ServerConfig | null, serverUrl: string | null): string {
  if (config) {
    const segments = config.cwd.split(/[/\\]/).filter(Boolean);
    const candidate = segments.at(-1) ?? config.cwd;
    return /^t3[-_\s]?code$/i.test(candidate) ? "T3 Code" : candidate;
  }
  return serverUrl ?? "T3 Remote";
}
