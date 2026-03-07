import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

import type {
  ServerCodexRateLimitCredits,
  ServerCodexRateLimitWindow,
  ServerCodexRateLimits,
  ServerGetCodexRateLimitsInput,
} from "@t3tools/contracts";

import { buildCodexInitializeParams } from "./codexAppServerManager";

const APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;

interface PendingRequest {
  readonly method: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface JsonRpcResponse {
  readonly id?: string | number;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function toIsoFromEpochSeconds(value: number | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const timestamp = new Date(value * 1000);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function normalizeWindow(value: unknown): ServerCodexRateLimitWindow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const usedPercent = clampPercent(asNumber(record.usedPercent));
  const resetsAt = toIsoFromEpochSeconds(asNumber(record.resetsAt));
  const windowDurationMins = asNumber(record.windowDurationMins);
  if (resetsAt === null || windowDurationMins === undefined) {
    return null;
  }

  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowDurationMins: Math.max(0, Math.round(windowDurationMins)),
    resetsAt,
  };
}

function normalizeCredits(value: unknown): ServerCodexRateLimitCredits | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return {
    hasCredits: asBoolean(record.hasCredits) === true,
    unlimited: asBoolean(record.unlimited) === true,
    balance: asNumber(record.balance) ?? null,
  };
}

export function normalizeCodexRateLimitsResponse(
  response: unknown,
  fetchedAt = new Date().toISOString(),
): ServerCodexRateLimits {
  const payload = asRecord(response);
  const directRateLimits = asRecord(payload?.rateLimits);
  const rateLimitsByLimitId = asRecord(payload?.rateLimitsByLimitId);
  const firstRateLimit = rateLimitsByLimitId
    ? Object.values(rateLimitsByLimitId).find((value) => asRecord(value) !== undefined)
    : undefined;
  const rateLimits = directRateLimits ?? asRecord(firstRateLimit);

  if (!rateLimits) {
    throw new Error("Codex rate-limit response did not include rate-limit data.");
  }

  return {
    fetchedAt,
    limitId: asString(rateLimits.limitId) ?? null,
    limitName: asString(rateLimits.limitName) ?? null,
    planType: asString(rateLimits.planType) ?? null,
    primary: normalizeWindow(rateLimits.primary),
    secondary: normalizeWindow(rateLimits.secondary),
    credits: normalizeCredits(rateLimits.credits),
  };
}

function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall back to direct kill below.
    }
  }
  child.kill();
}

export async function fetchCodexRateLimits(
  input: ServerGetCodexRateLimitsInput,
): Promise<ServerCodexRateLimits> {
  const child = spawn(input.binaryPath ?? "codex", ["app-server"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const output = readline.createInterface({ input: child.stdout });
  const pending = new Map<string, PendingRequest>();
  const stderrLines: string[] = [];
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    output.close();
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
    }
    pending.clear();
    if (!child.killed) {
      killChildTree(child);
    }
  };

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const sendMessage = (message: unknown) => {
    if (!child.stdin.writable) {
      throw new Error("Cannot write to Codex app-server stdin.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  let nextRequestId = 1;
  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, APP_SERVER_REQUEST_TIMEOUT_MS);
      pending.set(String(id), { method, timeout, resolve, reject });
      sendMessage({ id, method, params });
    });
  };

  output.on("line", (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const response = parsed as JsonRpcResponse;
    const responseId =
      typeof response.id === "string" || typeof response.id === "number"
        ? String(response.id)
        : null;
    if (responseId === null) {
      return;
    }

    const request = pending.get(responseId);
    if (!request) {
      return;
    }

    clearTimeout(request.timeout);
    pending.delete(responseId);

    if (response.error?.message) {
      request.reject(new Error(`${request.method} failed: ${response.error.message}`));
      return;
    }

    request.resolve(response.result);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf8").split(/\r?\n/g);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        stderrLines.push(trimmed);
      }
    }
  });

  child.on("error", (error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
    cleanup();
  });

  child.on("exit", (code, signal) => {
    if (pending.size === 0) {
      cleanup();
      return;
    }
    const stderrMessage = stderrLines[stderrLines.length - 1];
    rejectPending(
      new Error(
        stderrMessage ??
          `Codex app-server exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
      ),
    );
    cleanup();
  });

  try {
    await sendRequest("initialize", buildCodexInitializeParams());
    sendMessage({ method: "initialized" });
    const response = await sendRequest("account/rateLimits/read", {});
    return normalizeCodexRateLimitsResponse(response);
  } finally {
    cleanup();
  }
}
