import type { AgentSessionImportWindow } from "@t3tools/contracts";

/** Selector copy for how far back agent history import reaches. */
export const AGENT_SESSION_IMPORT_WINDOW_LABELS: Record<AgentSessionImportWindow, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "1y": "Last year",
  all: "All history",
};

export const AGENT_SESSION_IMPORT_WINDOWS = ["30d", "90d", "1y", "all"] as const;

/**
 * Native menu action ids arrive as plain strings; narrow them back to the
 * setting's literals so a stray id can never reach the server patch.
 */
export function parseAgentSessionImportWindow(value: string): AgentSessionImportWindow | null {
  switch (value) {
    case "30d":
    case "90d":
    case "1y":
    case "all":
      return value;
    default:
      return null;
  }
}

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}
