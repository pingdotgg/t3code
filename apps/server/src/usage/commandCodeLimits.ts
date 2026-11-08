// @effect-diagnostics globalDate:off -- upstream reset timestamps are epoch milliseconds or ISO.

import {
  ProviderDriverKind,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

// These endpoints are used by Command Code CLI 1.88.2, not part of a public
// stable API. Fail closed when they change; never manufacture quota percentages.
const ORIGIN = "https://api.commandcode.ai";
const CLIENT_USER_AGENT = "command-code/1.88.2";
const SOURCE_ID = UsageLimitSourceId.make("command-code-local");
const DRIVER = ProviderDriverKind.make("command-code");
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resetTimestamp(value: unknown): string | undefined {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? value < 1e11
        ? value * 1_000
        : value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const timestamp = new Date(parsed);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

export function commandCodeMonthlyWindow(
  creditsPayload: unknown,
  subscriptionPayload: unknown,
  summaryPayload?: unknown,
): ServerProviderUsageWindow | null {
  const credits = object(object(creditsPayload)?.credits);
  const subscription = object(object(subscriptionPayload)?.data);
  const remaining = validNumber(credits?.monthlyCredits);
  const summary = object(summaryPayload);
  const explicitAllowance = validNumber(credits?.monthlyCreditsTotal);
  const periodStart = resetTimestamp(subscription?.currentPeriodStart);
  const summaryPeriodStart = resetTimestamp(summary?.periodStart);
  const consumed = validNumber(summary?.totalMonthlyCredits);
  // The CLI's billing-period summary reports consumed *monthly* credits,
  // excluding purchased/free credits. Reconstruct the effective allowance
  // from consumed + remaining only when both describe the same billing period.
  // Never use the published per-model usage-value allowances as a denominator.
  const matchedBillingCycle =
    summary?.periodBasis === "billing-period" &&
    periodStart !== undefined &&
    periodStart === summaryPeriodStart &&
    consumed !== null &&
    consumed >= 0;
  const allowance =
    matchedBillingCycle && remaining !== null
      ? explicitAllowance !== null
        ? explicitAllowance
        : remaining + consumed
      : null;
  const resetsAt = resetTimestamp(subscription?.currentPeriodEnd);
  if (
    subscription?.status !== "active" ||
    allowance === null ||
    allowance <= 0 ||
    remaining === null ||
    remaining < 0 ||
    remaining > allowance ||
    !Number.isFinite(allowance) ||
    !resetsAt
  )
    return null;
  return {
    id: "command_monthly",
    kind: "monthly",
    label: "Monthly plan credits",
    usedPercent: ((allowance - remaining) / allowance) * 100,
    resetsAt,
  };
}

/** Command Code exposes used and cap in credits; never infer from token spend. */
export function commandCodeWindows(payload: unknown): ServerProviderUsageWindow[] {
  const limits = object(object(payload)?.windowLimits);
  if (!limits) return [];
  const descriptions = [
    { key: "fiveHour", id: "command_five_hour", label: "5 hours", kind: "session", minutes: 300 },
    { key: "weekly", id: "command_weekly", label: "Weekly", kind: "weekly", minutes: 10080 },
  ] as const;
  return descriptions.flatMap(({ key, id, label, kind, minutes }) => {
    const value = object(limits[key]);
    if (!value) return [];
    const used = validNumber(value.used);
    const cap = validNumber(value.cap);
    if (used === null || cap === null || used < 0 || cap <= 0) return [];
    const resetsAt = resetTimestamp(value.resetAt);
    return [
      {
        id,
        label,
        kind,
        usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
        windowDurationMins: minutes,
        ...(resetsAt ? { resetsAt } : {}),
      },
    ];
  });
}

function credential(content: string): string | null {
  try {
    const auth = object(JSON.parse(content));
    const key = auth?.apiKey;
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
}

export const readCommandCodeLimitSource = Effect.fn("readCommandCodeLimitSource")(
  function* (options?: { readonly authPath?: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const authPath =
      options?.authPath ?? path.join(yield* HostProcess.HomeDirectory, ".commandcode", "auth.json");
    const content = yield* fileSystem
      .readFileString(authPath)
      .pipe(Effect.orElseSucceed(() => null));
    // When not signed in, Command Code is an unavailable local limits source.
    if (content === null) return null;

    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: SOURCE_ID,
      // Compatibility envelope: older T3 Connect clients decode source.kind as
      // the single literal "cliproxy". Its account.driver remains "command-code"
      // and the actual endpoint is still the Command Code API, never a cliproxy.
      kind: "cliproxy" as const,
      label: "Command Code",
      checkedAt,
    };
    const apiKey = credential(content);
    if (!apiKey)
      return { ...base, accounts: [], error: "Command Code credentials are unavailable." };

    const client = yield* HttpClient.HttpClient;
    const get = (url: string) =>
      client
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.setHeader("user-agent", CLIENT_USER_AGENT),
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.timeout("8 seconds"),
        );
    const response = yield* Effect.gen(function* () {
      const whoami = object(yield* get(ORIGIN + "/alpha/whoami?limits=1"));
      if (!whoami || whoami.success === false) return null;
      const organization = object(whoami.org);
      const organizationId = organization?.id;
      const query =
        typeof organizationId === "string" && organizationId.length > 0
          ? "?orgId=" + encodeURIComponent(organizationId)
          : "";
      // Each request is bounded independently so optional billing timeouts preserve rolling windows.
      const [credits, subscription, summary] = yield* Effect.all(
        [
          get(ORIGIN + "/alpha/billing/credits" + query),
          get(ORIGIN + "/alpha/billing/subscriptions" + query).pipe(
            Effect.orElseSucceed(() => null),
          ),
          get(ORIGIN + "/alpha/usage/summary" + query).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 3 },
      );
      return { credits, subscription, summary, organizationId };
    }).pipe(Effect.orElseSucceed(() => null));

    if (response === null)
      return { ...base, accounts: [], error: "Command Code quota API is unavailable." };
    const windows = commandCodeWindows(response.credits);
    const monthly = commandCodeMonthlyWindow(
      response.credits,
      response.subscription,
      response.summary,
    );
    if (monthly) windows.push(monthly);
    if (
      windows.length === 0 &&
      object(response.credits)?.windowLimits &&
      object(object(response.credits)?.windowLimits)?.limited === false
    )
      return null;
    if (windows.length === 0)
      return { ...base, accounts: [], error: "Command Code did not report rolling quota windows." };
    const digest = yield* Digest.Digest;
    const credentialFingerprint = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(`command-code\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...base,
      accounts: [
        {
          id: "Command Code",
          driver: DRIVER,
          ...(typeof response.organizationId === "string" && response.organizationId.length > 0
            ? { workspaceId: response.organizationId }
            : {}),
          usageLimits: { checkedAt, windows, credentialFingerprint },
        },
      ],
    } satisfies UsageLimitSourceSnapshot;
  },
);
