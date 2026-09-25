// Node fs reads CLI credentials, and crypto hashes account IDs for deduplication.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";

import type { UsageRecord } from "./usageTranscripts.ts";
import { readMacCursorAccessToken } from "../provider/cursorCredentialStore.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export interface CursorAccountUsageReadResult {
  readonly accountKey: string | null;
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: string | null;
}

const accountHash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Find the longest exact suffix/prefix overlap in linear time. */
function boundaryOverlap(previous: readonly string[], current: readonly string[]): number {
  const sequence = [...current, "", ...previous];
  const lengths = Array.from({ length: sequence.length }, () => 0);
  for (let index = 1; index < sequence.length; index++) {
    let length = lengths[index - 1]!;
    while (length > 0 && sequence[index] !== sequence[length]) length = lengths[length - 1]!;
    if (sequence[index] === sequence[length]) length++;
    lengths[index] = length;
  }
  return lengths.at(-1) ?? 0;
}

/** Dashboard usage includes headless agents and reports fresh input separately from cache reads. */
export async function readCursorAccountUsage(
  credentialSource: string | { readonly kind: "keychain" },
  sinceMs: number,
  endDate: number,
  request: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
  keychainToken: () => Promise<string | null> = readMacCursorAccessToken,
): Promise<CursorAccountUsageReadResult> {
  let accessToken: unknown;
  try {
    accessToken =
      typeof credentialSource === "string"
        ? object(JSON.parse(await NodeFSP.readFile(credentialSource, "utf8"))).accessToken
        : await keychainToken();
  } catch (cause) {
    const missing = typeof credentialSource === "string" && object(cause).code === "ENOENT";
    return {
      accountKey: null,
      records: [],
      missing,
      error: missing
        ? null
        : typeof credentialSource === "string"
          ? "Cursor credentials could not be read."
          : "Cursor Keychain credentials could not be read.",
    };
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return {
      accountKey: null,
      records: [],
      missing: true,
      error:
        typeof credentialSource === "string"
          ? null
          : "Cursor account history needs a macOS Keychain CLI login on this server.",
    };
  }
  let accountKey: string | null = null;
  try {
    const payload = accessToken.split(".")[1];
    const subject = object(
      JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
    ).sub;
    if (typeof subject !== "string" || !subject) throw new Error("Invalid authentication");
    const userId = subject.split("|").at(-1);
    if (!userId) throw new Error("Invalid authentication");
    accountKey = accountHash(subject);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(endDate) || sinceMs < 0 || sinceMs > endDate)
      throw new Error("Invalid date window");
    const deadline = AbortSignal.timeout(60_000);
    const records: UsageRecord[] = [];
    const occurrences = new Map<string, number>();
    const pages: unknown[][] = [];
    let completed = false;
    const pageSize = 1000;
    let total: number | undefined;
    for (let page = 1; ; page++) {
      // A count can include overlapping page boundaries. Allow room to
      // reconcile them without imposing a fixed account-size limit.
      if (page > (total === undefined ? 1000 : Math.ceil(total / pageSize) * 2 + 1)) {
        throw new Error("Account usage page limit exceeded");
      }
      const response = await request("https://cursor.com/api/dashboard/get-filtered-usage-events", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://cursor.com",
          Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
        },
        body: JSON.stringify({
          page,
          pageSize,
          startDate: String(sinceMs),
          endDate: String(endDate),
        }),
      });
      if (response.status === 401 || response.status === 403) {
        return {
          accountKey,
          records: [],
          missing: false,
          error: "Sign in to Cursor again to read account usage.",
        };
      }
      if (!response.ok) throw new Error("Account usage request failed");
      const parsed: unknown = await response.json();
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid account usage page");
      }
      const body = object(parsed);
      const keys = Object.keys(body);
      if ("error" in body || "message" in body || "code" in body)
        throw new Error("Account usage error response");
      const count = keys.length === 0 ? 0 : body.totalUsageEventsCount;
      const events =
        keys.length === 0 || (keys.length === 1 && keys[0] === "totalUsageEventsCount")
          ? []
          : body.usageEventsDisplay;
      if (
        (count !== undefined &&
          (typeof count !== "number" ||
            !Number.isSafeInteger(count) ||
            count < 0 ||
            (total !== undefined && count !== total))) ||
        !Array.isArray(events) ||
        events.length > pageSize ||
        (count === undefined && !Array.isArray(body.usageEventsDisplay))
      ) {
        throw new Error("Inconsistent account usage page");
      }
      if (typeof count === "number") total = count;
      pages.push(events);
      if (events.length < pageSize) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error("Account usage page limit exceeded");
    const rawCount = pages.reduce((sum, page) => sum + page.length, 0);
    if (total !== undefined && rawCount < total) throw new Error("Incomplete account usage pages");
    let removalsRemaining = total === undefined ? 0 : rawCount - total;
    let previousKeys: string[] = [];
    for (const events of pages) {
      const eventKeys =
        removalsRemaining > 0 ? events.map((event) => accountHash(canonicalJson(event))) : [];
      const removalCount = Math.min(removalsRemaining, boundaryOverlap(previousKeys, eventKeys));
      removalsRemaining -= removalCount;
      previousKeys = eventKeys;
      for (const raw of events.slice(removalCount)) {
        const event = object(raw);
        const usage = object(event.tokenUsage);
        if (event.tokenUsage === undefined || event.tokenUsage === null) continue;
        for (const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "totalCents",
        ]) {
          const value = usage[key];
          if (
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          ) {
            throw new Error("Invalid account usage totals");
          }
        }
        const timestampMs =
          typeof event.timestamp === "string" && event.timestamp.trim() !== ""
            ? Number(event.timestamp)
            : event.timestamp;
        if (
          typeof timestampMs !== "number" ||
          !Number.isFinite(timestampMs) ||
          typeof event.model !== "string" ||
          !event.model
        )
          throw new Error("Invalid account usage event");
        if (timestampMs < sinceMs || timestampMs > endDate) continue;
        const totals = {
          uncachedInputTokens: tokens(usage.inputTokens),
          cachedInputTokens: tokens(usage.cacheReadTokens),
          cacheCreationTokens: tokens(usage.cacheWriteTokens),
          outputTokens: tokens(usage.outputTokens),
          reasoningTokens: 0,
        };
        const reportedCostUsd =
          typeof usage.totalCents === "number" ? usage.totalCents / 100 : null;
        const sessionId = typeof event.conversationId === "string" ? event.conversationId : "";
        // No event ID is provided. Preserve identical billed rows with an occurrence index.
        const key = accountHash(
          JSON.stringify([timestampMs, event.model, sessionId, totals, reportedCostUsd]),
        );
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        records.push({
          provider: "cursor",
          timestampMs,
          model: event.model,
          sessionId,
          totals,
          reportedCostUsd,
          fast: false,
          dedupeKey: `cursor-account:${accountKey}:${key}:${occurrence}`,
        });
      }
      await NodeTimersPromises.setImmediate();
    }
    if (removalsRemaining !== 0) throw new Error("Inconsistent account usage boundaries");
    return { accountKey, records, missing: false, error: null };
  } catch {
    return {
      accountKey,
      records: [],
      missing: false,
      error: "Cursor account usage could not be read.",
    };
  }
}
