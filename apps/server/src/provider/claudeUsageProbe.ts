import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { makeUnavailableUsageLimits, makeUsageLimitsSnapshot } from "./providerUsageLimits.ts";

const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 4_000;
const CLAUDE_USAGE_FALLBACK_IDLE_MS = 150;
const ANSI_PATTERN =
  // Matches common CSI / OSC ANSI escape sequences.
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const nodePtyModulePromise = import("node-pty");

export interface ClaudeUsageProbeResult {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly rawOutput: string;
}

export function shouldRequestClaudeUsageFallback(input: {
  readonly output: string;
  readonly checkedAt: string;
  readonly fallbackAlreadySent?: boolean;
}): boolean {
  if (input.fallbackAlreadySent) {
    return false;
  }

  const parsed = parseClaudeUsageLimitsOutput(input);
  return !parsed.available;
}

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, "");
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferWindowDurationMins(value: string): number | undefined {
  const lower = value.toLowerCase();
  if (/\bweekly\b|\b7\s*(?:d|day|days)\b/.test(lower)) {
    return 7 * 24 * 60;
  }
  if (/\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)) {
    return 5 * 60;
  }
  return undefined;
}

function detectClaudeUsageWindowKind(value: string): "session" | "weekly" | undefined {
  const lower = value.toLowerCase();
  if (/\bweekly\b|\b7\s*(?:d|day|days)\b/.test(lower)) {
    return "weekly";
  }
  if (/\b5\s*(?:h|hr|hrs|hour|hours)\b|\bsession\b/.test(lower)) {
    return "session";
  }
  return undefined;
}

function extractResetTimestamp(value: string): string | undefined {
  const resetMatch = value.match(
    /\breset(?:s|ting)?(?:\s+(?:at|on|in))?[:\s-]*([A-Za-z]{3,9}[^,\n]*\d{1,2}[^,\n]*\d{2,4}[^,\n]*|\d{4}-\d{2}-\d{2}T[^\s,]+|\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?(?:\s*[A-Z]{2,5})?)/i,
  );
  const candidate = resetMatch?.[1]?.trim();
  if (!candidate) return undefined;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function parseClaudeUsageWindowSegment(
  kind: "session" | "weekly",
  segment: string,
): {
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt?: string;
} | null {
  const percentMatch = segment.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const usedPercent = parsePercent(percentMatch?.[1]);
  const windowDurationMins = inferWindowDurationMins(segment);
  if (usedPercent === undefined || windowDurationMins === undefined) {
    return null;
  }
  const resetsAt = extractResetTimestamp(segment);

  return {
    label: kind === "session" ? "Session" : "Weekly",
    usedPercent,
    windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function extractWindowSegments(output: string): ReadonlyArray<{
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt?: string;
}> {
  const lines = output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const windows = new Map<"session" | "weekly", (typeof lines)[number]>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const kind = detectClaudeUsageWindowKind(line);
    if (!kind || windows.has(kind)) continue;

    const segmentLines = [line];
    for (let cursor = index + 1; cursor < lines.length && segmentLines.length < 3; cursor += 1) {
      const candidate = lines[cursor]!;
      if (detectClaudeUsageWindowKind(candidate)) {
        break;
      }
      segmentLines.push(candidate);
    }
    const neighborhood = segmentLines.join(" ");
    windows.set(kind, neighborhood);
  }

  return [...windows.entries()].flatMap(([kind, segment]) => {
    const parsed = parseClaudeUsageWindowSegment(kind, segment);
    if (!parsed) {
      return [];
    }

    return [parsed];
  });
}

export function parseClaudeUsageLimitsOutput(input: {
  readonly output: string;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const cleanedOutput = stripAnsi(input.output);
  const lowerOutput = cleanedOutput.toLowerCase();

  if (/\bapi key\b|\bapi-key\b/.test(lowerOutput)) {
    return makeUnavailableUsageLimits({
      source: "claudeStatusProbe",
      checkedAt: input.checkedAt,
      reason: "Usage limits unavailable for Claude API key accounts.",
    });
  }

  const windows = extractWindowSegments(cleanedOutput);
  if (windows.length === 0) {
    return makeUnavailableUsageLimits({
      source: "claudeStatusProbe",
      checkedAt: input.checkedAt,
      reason: "Usage limits unavailable for this Claude account.",
    });
  }

  return makeUsageLimitsSnapshot({
    source: "claudeStatusProbe",
    checkedAt: input.checkedAt,
    windows,
    unavailableReason: "Usage limits unavailable for this Claude account.",
  });
}

export async function probeClaudeUsageLimits(input: {
  readonly binaryPath: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly checkedAt: string;
}): Promise<ClaudeUsageProbeResult> {
  const nodePty = await nodePtyModulePromise;
  const probeArgs = [
    ...(input.launchArgs?.trim().split(/\s+/).filter(Boolean) ?? []),
    "--permission-mode",
    "plan",
  ];

  return await new Promise((resolve) => {
    const child = nodePty.spawn(input.binaryPath, probeArgs, {
      cwd: input.cwd,
      cols: 120,
      rows: 40,
      env: process.env,
      name: process.platform === "win32" ? "xterm-color" : "xterm-256color",
    });
    let rawOutput = "";
    let sentFallback = false;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleFallback = () => {
      if (sentFallback || settled) {
        return;
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined;
        maybeRequestFallback();
      }, CLAUDE_USAGE_FALLBACK_IDLE_MS);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      offData.dispose();
      offExit.dispose();
      try {
        child.kill();
      } catch {
        // Ignore kill failures during cleanup.
      }
      resolve({
        usageLimits: parseClaudeUsageLimitsOutput({
          output: rawOutput,
          checkedAt: input.checkedAt,
        }),
        rawOutput,
      });
    };

    const maybeRequestFallback = () => {
      if (sentFallback) return;
      if (
        !shouldRequestClaudeUsageFallback({
          output: rawOutput,
          checkedAt: input.checkedAt,
          fallbackAlreadySent: sentFallback,
        })
      ) {
        finish();
        return;
      }
      sentFallback = true;
      child.write("/usage\r");
    };

    const timeout = setTimeout(() => {
      finish();
    }, CLAUDE_USAGE_PROBE_TIMEOUT_MS);

    const offData = child.onData((data) => {
      rawOutput += data;
      const parsed = parseClaudeUsageLimitsOutput({
        output: rawOutput,
        checkedAt: input.checkedAt,
      });
      if (parsed.available) {
        finish();
        return;
      }
      if (!sentFallback) {
        scheduleFallback();
      }
    });

    const offExit = child.onExit(() => {
      finish();
    });

    child.write("/status\r");
    scheduleFallback();
  });
}
