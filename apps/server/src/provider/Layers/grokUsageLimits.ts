/**
 * SuperGrok / Grok Build weekly plan usage. The Grok CLI does not stream
 * rate-limit notifications, so one mapper serves the HTTP billing probe and
 * the ACP `x.ai/billing` extension: both emit a single weekly window with a
 * stable id so they merge onto the same Limits row.
 *
 * @module provider/Layers/grokUsageLimits
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

export const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const WEEK_MINS = 7 * 24 * 60;
const WEEKLY_WINDOW_ID = "weekly";
const parseJsonString = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

function parseJson(raw: string): unknown | undefined {
  const result = parseJsonString(raw);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface FetchGrokUsageLimitsInput {
  readonly checkedAt: string;
  readonly cliVersion: string | null;
  readonly homeDir: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `~/.grok/auth.json` stores account objects. The SuperGrok token is the `key`
 * string on the single object value that carries one. Read at request time
 * only; never persist or log the value.
 */
export function readGrokAuthToken(authJson: unknown): string | undefined {
  const root = asRecord(authJson);
  if (!root) return undefined;
  const matches: string[] = [];
  for (const value of Object.values(root)) {
    const record = asRecord(value);
    const key = record?.key;
    if (typeof key === "string" && key.length > 0) {
      matches.push(key);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function grokAuthFilePath(homeDir: string): string {
  return NodePath.join(homeDir, ".grok", "auth.json");
}

function currentPeriodFromConfig(
  config: Record<string, unknown>,
): { readonly end: string } | undefined {
  const period = asRecord(config.currentPeriod);
  if (!period || typeof period.end !== "string" || period.end.length === 0) {
    return undefined;
  }
  return { end: period.end };
}

function grokBillingToWindows(body: unknown): ReadonlyArray<ServerProviderUsageWindow> {
  const root = asRecord(body);
  const config = asRecord(root?.config);
  if (!config) return [];
  const period = currentPeriodFromConfig(config);
  if (!period) return [];
  const usedPercent = typeof config.creditUsagePercent === "number" ? config.creditUsagePercent : 0;
  const resetsAt = isoFromString(period.end);
  return [
    {
      id: WEEKLY_WINDOW_ID,
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(usedPercent),
      windowDurationMins: WEEK_MINS,
      ...(resetsAt ? { resetsAt } : {}),
    },
  ];
}

/**
 * Map a Grok billing payload. Proto3 JSON omits zero-valued fields: a present
 * `currentPeriod` without `creditUsagePercent` is 0 %. Missing period is
 * unsupported rather than an empty successful snapshot.
 */
export function grokBillingResponseToLimits(
  body: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows = grokBillingToWindows(body);
  if (windows.length === 0) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  return makeUsageLimits({ checkedAt, windows });
}

export function grokBillingResponseToUpdate(body: unknown): ProviderUsageLimitsUpdate | undefined {
  const windows = grokBillingToWindows(body);
  return windows.length > 0 ? { windows } : undefined;
}

function unavailable(
  checkedAt: string,
  reason: "unsupported" | "probeFailed",
): ServerProviderUsageLimits {
  return makeUnavailableUsageLimits({ checkedAt, reason });
}

/**
 * GET `cli-chat-proxy.grok.com/v1/billing`. Never throws: every failure is an
 * unavailable snapshot. The bearer token is read from `~/.grok/auth.json` for
 * this request only.
 */
export async function fetchGrokUsageLimits(
  input: FetchGrokUsageLimitsInput,
): Promise<ServerProviderUsageLimits> {
  const { checkedAt, cliVersion, homeDir } = input;
  try {
    const authPath = grokAuthFilePath(homeDir);
    const readFile = input.readFile ?? ((path: string) => NodeFS.readFile(path, "utf8"));
    let authRaw: string;
    try {
      authRaw = await readFile(authPath);
    } catch {
      return unavailable(checkedAt, "unsupported");
    }
    const authJson = parseJson(authRaw);
    if (authJson === undefined) {
      return unavailable(checkedAt, "unsupported");
    }
    const token = readGrokAuthToken(authJson);
    if (!token) {
      return unavailable(checkedAt, "unsupported");
    }

    const fetchImpl = input.fetch ?? globalThis.fetch;
    const response = await fetchImpl(GROK_BILLING_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": `grok/${cliVersion ?? "0"}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return unavailable(checkedAt, "probeFailed");
    }
    const body = parseJson(await response.text());
    if (body === undefined) {
      return unavailable(checkedAt, "probeFailed");
    }
    return grokBillingResponseToLimits(body, checkedAt);
  } catch {
    return unavailable(checkedAt, "probeFailed");
  }
}
