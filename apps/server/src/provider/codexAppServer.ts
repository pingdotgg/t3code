import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { ServerProviderSkill, ServerProviderUsageLimits } from "@t3tools/contracts";
import { readCodexAccountSnapshot, type CodexAccountSnapshot } from "./codexAccount.ts";
import {
  makeUsageLimitsSnapshot,
  toIsoDateTimeFromUnixSeconds,
  type RawUsageWindowInput,
} from "./providerUsageLimits.ts";

interface JsonRpcProbeResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: unknown;
  };
}

export interface CodexDiscoverySnapshot {
  readonly account: CodexAccountSnapshot;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly rateLimits?: CodexRateLimitsSnapshot;
}

export interface CodexRateLimitWindowSnapshot {
  readonly usedPercent: number;
  readonly windowDurationMins?: number;
  readonly resetsAt?: string;
}

export interface CodexRateLimitsSnapshot {
  readonly windows: ReadonlyArray<CodexRateLimitWindowSnapshot>;
}

function readErrorMessage(response: JsonRpcProbeResponse): string | undefined {
  return typeof response.error?.message === "string" ? response.error.message : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  const candidate = readString(value)?.trim();
  return candidate ? candidate : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readUnixSecondsAsIso(value: unknown): string | undefined {
  const numeric = readNumber(value);
  if (numeric === undefined) {
    return undefined;
  }
  if (numeric > 10_000_000_000) {
    const date = new Date(numeric);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return toIsoDateTimeFromUnixSeconds(numeric);
}

function readWindowDurationMins(record: Record<string, unknown>): number | undefined {
  const direct =
    readNumber(record.windowDurationMins) ??
    readNumber(record.windowDurationMinutes) ??
    readNumber(record.window_duration_mins) ??
    readNumber(record.window_duration_minutes) ??
    readNumber(record.durationMinutes);
  if (direct !== undefined) {
    return direct;
  }

  const seconds =
    readNumber(record.windowDurationSeconds) ??
    readNumber(record.window_duration_seconds) ??
    readNumber(record.durationSeconds);
  if (seconds !== undefined) {
    return seconds / 60;
  }
  return undefined;
}

function readUsedPercent(record: Record<string, unknown>): number | undefined {
  const direct =
    readNumber(record.usedPercent) ??
    readNumber(record.used_percent) ??
    readNumber(record.usagePercent) ??
    readNumber(record.usage_percent) ??
    readNumber(record.percentUsed) ??
    readNumber(record.percent_used);
  if (direct !== undefined) {
    return direct;
  }

  const used =
    readNumber(record.used) ??
    readNumber(record.usedTokens) ??
    readNumber(record.used_tokens) ??
    readNumber(record.tokensUsed) ??
    readNumber(record.tokens_used);
  const limit =
    readNumber(record.limit) ??
    readNumber(record.total) ??
    readNumber(record.max) ??
    readNumber(record.maxTokens) ??
    readNumber(record.max_tokens) ??
    readNumber(record.tokensLimit) ??
    readNumber(record.tokens_limit);
  if (used !== undefined && limit !== undefined && limit > 0) {
    return (used / limit) * 100;
  }

  const remaining =
    readNumber(record.remaining) ??
    readNumber(record.remainingTokens) ??
    readNumber(record.remaining_tokens) ??
    readNumber(record.tokensRemaining) ??
    readNumber(record.tokens_remaining);
  if (remaining !== undefined && limit !== undefined && limit > 0) {
    return ((limit - remaining) / limit) * 100;
  }

  return undefined;
}

function withFallbackCodexWindowDurations(
  windows: ReadonlyArray<CodexRateLimitWindowSnapshot>,
): ReadonlyArray<CodexRateLimitWindowSnapshot> {
  if (windows.length === 0 || windows.every((window) => window.windowDurationMins !== undefined)) {
    return windows;
  }

  const SESSION_WINDOW_MINS = 300;
  const WEEKLY_WINDOW_MINS = 10_080;
  const missingDurationCount = windows.filter(
    (window) => window.windowDurationMins === undefined,
  ).length;

  if (missingDurationCount === 0) {
    return windows;
  }

  const knownDurations = windows
    .map((window) => window.windowDurationMins)
    .filter(
      (duration): duration is number => typeof duration === "number" && Number.isFinite(duration),
    );
  const knownShortest = knownDurations.length > 0 ? Math.min(...knownDurations) : undefined;
  const knownLongest = knownDurations.length > 0 ? Math.max(...knownDurations) : undefined;
  const prefersSessionFallback =
    knownShortest === undefined || Math.abs(knownShortest - SESSION_WINDOW_MINS) <= 60;
  const prefersWeeklyFallback =
    knownLongest !== undefined && Math.abs(knownLongest - WEEKLY_WINDOW_MINS) <= 240;

  const byResetTime = [...windows].toSorted((left, right) => {
    const leftAt = left.resetsAt ? Date.parse(left.resetsAt) : Number.NaN;
    const rightAt = right.resetsAt ? Date.parse(right.resetsAt) : Number.NaN;
    if (Number.isNaN(leftAt) && Number.isNaN(rightAt)) return 0;
    if (Number.isNaN(leftAt)) return 1;
    if (Number.isNaN(rightAt)) return -1;
    return leftAt - rightAt;
  });

  const fallbackDurationByWindow = new Map<CodexRateLimitWindowSnapshot, number>();
  if (byResetTime.length === 1) {
    fallbackDurationByWindow.set(byResetTime[0]!, knownShortest ?? SESSION_WINDOW_MINS);
  } else {
    byResetTime.forEach((window, index) => {
      if (index === 0) {
        fallbackDurationByWindow.set(
          window,
          prefersSessionFallback ? SESSION_WINDOW_MINS : (knownShortest ?? SESSION_WINDOW_MINS),
        );
        return;
      }
      if (index === byResetTime.length - 1) {
        fallbackDurationByWindow.set(
          window,
          prefersWeeklyFallback ? WEEKLY_WINDOW_MINS : (knownLongest ?? WEEKLY_WINDOW_MINS),
        );
        return;
      }
      fallbackDurationByWindow.set(window, knownLongest ?? WEEKLY_WINDOW_MINS);
    });
  }

  return windows.map((window) =>
    window.windowDurationMins !== undefined
      ? window
      : {
          ...window,
          windowDurationMins: fallbackDurationByWindow.get(window) ?? SESSION_WINDOW_MINS,
        },
  );
}

function collectCodexRateLimitWindows(value: unknown): ReadonlyArray<CodexRateLimitWindowSnapshot> {
  const seen = new Set<object>();
  const visit = (candidate: unknown): ReadonlyArray<CodexRateLimitWindowSnapshot> => {
    if (Array.isArray(candidate)) {
      return candidate.flatMap(visit);
    }

    const record = readObject(candidate);
    if (!record) {
      return [];
    }
    if (seen.has(record)) {
      return [];
    }
    seen.add(record);

    const usedPercent = readUsedPercent(record);
    if (usedPercent !== undefined) {
      const windowDurationMins = readWindowDurationMins(record);
      const resetsAt =
        readUnixSecondsAsIso(record.resetsAt) ??
        readUnixSecondsAsIso(record.resetAt) ??
        readUnixSecondsAsIso(record.reset_at) ??
        readUnixSecondsAsIso(record.resets_at);
      return [
        {
          usedPercent,
          ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
          ...(resetsAt ? { resetsAt } : {}),
        },
      ];
    }

    return Object.values(record).flatMap(visit);
  };

  const deduped = new Map<string, CodexRateLimitWindowSnapshot>();
  for (const window of visit(value)) {
    const key = JSON.stringify(window);
    if (!deduped.has(key)) {
      deduped.set(key, window);
    }
  }
  return [...deduped.values()];
}

export function readCodexRateLimitsSnapshot(result: unknown): CodexRateLimitsSnapshot | undefined {
  const record = readObject(result);
  const preferred = readObject(readObject(record?.rateLimitsByLimitId)?.codex);
  const candidate =
    preferred?.rateLimits ??
    preferred?.limits ??
    record?.rateLimits ??
    record?.limits ??
    preferred ??
    (record && readNumber(record.usedPercent) !== undefined ? record : undefined);
  const windows = withFallbackCodexWindowDurations(collectCodexRateLimitWindows(candidate));
  return windows.length > 0 ? { windows } : undefined;
}

export function normalizeCodexUsageLimits(input: {
  readonly checkedAt: string;
  readonly rateLimits?: CodexRateLimitsSnapshot;
}): ServerProviderUsageLimits {
  const windows: RawUsageWindowInput[] =
    input.rateLimits?.windows.map((window) => ({
      label: "Codex quota window",
      usedPercent: window.usedPercent,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      ...(typeof window.windowDurationMins === "number"
        ? { windowDurationMins: window.windowDurationMins }
        : {}),
    })) ?? [];

  return makeUsageLimitsSnapshot({
    source: "codexAppServer",
    checkedAt: input.checkedAt,
    windows,
    unavailableReason: "No Codex subscription quota windows reported.",
  });
}

function parseCodexSkillsResult(result: unknown, cwd: string): ReadonlyArray<ServerProviderSkill> {
  const resultRecord = readObject(result);
  const dataBuckets = readArray(resultRecord?.data) ?? [];
  const matchingBucket = dataBuckets.find(
    (value) => nonEmptyTrimmed(readObject(value)?.cwd) === cwd,
  );
  const rawSkills =
    readArray(readObject(matchingBucket)?.skills) ?? readArray(resultRecord?.skills) ?? [];

  return rawSkills.flatMap((value) => {
    const skill = readObject(value);
    const display = readObject(skill?.interface);
    const name = nonEmptyTrimmed(skill?.name);
    const path = nonEmptyTrimmed(skill?.path);
    if (!name || !path) {
      return [];
    }

    return [
      {
        name,
        path,
        enabled: skill?.enabled !== false,
        ...(nonEmptyTrimmed(skill?.description)
          ? { description: nonEmptyTrimmed(skill?.description) }
          : {}),
        ...(nonEmptyTrimmed(skill?.scope) ? { scope: nonEmptyTrimmed(skill?.scope) } : {}),
        ...(nonEmptyTrimmed(display?.displayName)
          ? { displayName: nonEmptyTrimmed(display?.displayName) }
          : {}),
        ...(nonEmptyTrimmed(skill?.shortDescription) || nonEmptyTrimmed(display?.shortDescription)
          ? {
              shortDescription:
                nonEmptyTrimmed(skill?.shortDescription) ??
                nonEmptyTrimmed(display?.shortDescription),
            }
          : {}),
      } satisfies ServerProviderSkill,
    ];
  });
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

export function killCodexChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  child.kill();
}

interface CodexDiscoveryProbeState {
  account?: CodexAccountSnapshot;
  skills?: ReadonlyArray<ServerProviderSkill>;
  rateLimits: CodexRateLimitsSnapshot | undefined;
  rateLimitsResponseReceived: boolean;
}

function isCodexDiscoveryComplete(state: CodexDiscoveryProbeState): boolean {
  return Boolean(state.account) && state.skills !== undefined && state.rateLimitsResponseReceived;
}

function sendCodexDiscoveryRequests(writeMessage: (message: unknown) => void, cwd: string): void {
  writeMessage({ method: "initialized" });
  writeMessage({ id: 2, method: "skills/list", params: { cwds: [cwd] } });
  writeMessage({ id: 3, method: "account/read", params: {} });
  writeMessage({ id: 4, method: "account/rateLimits/read", params: {} });
}

function applyCodexDiscoveryResponse(input: {
  readonly response: JsonRpcProbeResponse;
  readonly cwd: string;
  readonly state: CodexDiscoveryProbeState;
  readonly writeMessage: (message: unknown) => void;
}): { readonly shouldResolve: boolean } {
  const { response, cwd, state, writeMessage } = input;

  if (response.id === 1) {
    const errorMessage = readErrorMessage(response);
    if (errorMessage) {
      throw new Error(`initialize failed: ${errorMessage}`);
    }
    sendCodexDiscoveryRequests(writeMessage, cwd);
    return { shouldResolve: false };
  }

  if (response.id === 2) {
    const errorMessage = readErrorMessage(response);
    state.skills = errorMessage ? [] : parseCodexSkillsResult(response.result, cwd);
    return { shouldResolve: isCodexDiscoveryComplete(state) };
  }

  if (response.id === 3) {
    const errorMessage = readErrorMessage(response);
    if (errorMessage) {
      throw new Error(`account/read failed: ${errorMessage}`);
    }
    state.account = readCodexAccountSnapshot(response.result);
    return { shouldResolve: isCodexDiscoveryComplete(state) };
  }

  if (response.id === 4) {
    const errorMessage = readErrorMessage(response);
    if (!errorMessage) {
      state.rateLimits = readCodexRateLimitsSnapshot(response.result);
    }
    state.rateLimitsResponseReceived = true;
    return { shouldResolve: isCodexDiscoveryComplete(state) };
  }

  return { shouldResolve: false };
}

export async function probeCodexDiscovery(input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<CodexDiscoverySnapshot> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, ["app-server"], {
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;
    const state: CodexDiscoveryProbeState = {
      rateLimits: undefined,
      rateLimitsResponseReceived: false,
    };

    const cleanup = () => {
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error(`Codex discovery probe failed: ${String(error)}.`),
        ),
      );

    const maybeResolve = () => {
      if (!isCodexDiscoveryComplete(state)) {
        return;
      }
      finish(() =>
        resolve({
          account: state.account!,
          skills: state.skills!,
          ...(state.rateLimits ? { rateLimits: state.rateLimits } : {}),
        }),
      );
    };

    if (input.signal?.aborted) {
      fail(new Error("Codex discovery probe aborted."));
      return;
    }
    input.signal?.addEventListener("abort", () =>
      fail(new Error("Codex discovery probe aborted.")),
    );

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error("Received invalid JSON from codex app-server during discovery probe."));
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      try {
        const response = parsed as JsonRpcProbeResponse;
        const next = applyCodexDiscoveryResponse({
          response,
          cwd: input.cwd,
          state,
          writeMessage,
        });
        if (!next.shouldResolve) {
          return;
        }
        maybeResolve();
      } catch (error) {
        fail(error);
      }
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (completed) return;
      fail(
        new Error(
          `codex app-server exited before probe completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}
